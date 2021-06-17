import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  //+ deps 就是 effect 中所依赖的 key 对应的 set 集合数组
  options: ReactiveEffectOptions
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  //+ 是否延迟触发 effect
  scheduler?: (job: ReactiveEffect) => void
  //+ 调度函数
  onTrack?: (event: DebuggerEvent) => void
  //+ 追踪时触发
  onTrigger?: (event: DebuggerEvent) => void
  //+ 触发回调时触发
  onStop?: () => void
  //+ 停止监听时触发
  /**
   * Indicates whether the job is allowed to recursively trigger itself when
   * managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  //+ 允许自执行
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined
//+ 存在激活的副作用

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
  //+ 默认为空 更新组件的effect会用到
): ReactiveEffect<T> {
  //+ 判断传入的fn是不是effect，如果是的话取出原始值
  if (isEffect(fn)) {
    fn = fn.raw
  }
  //+ 调用 createReactiveEffect 创建 新的effect
  const effect = createReactiveEffect(fn, options)
  //+ 是不是立即执行
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    if (!effect.active) {
      return fn()
    }
    //+ 首先判断是否当前 effect 是否在 effectStack 当中，
    //+ 如果在，则不进行调用，这个主要是为了避免死循环
    //+ 可以看下测试用例 should avoid infinite loops with other effects
    if (!effectStack.includes(effect)) {
      //+ 清除依赖, 每次 effect 运行都会重新收集依赖,
      cleanup(effect)
      //+ 开始重新收集依赖
      try {
        enableTracking()
        //+ 允许追踪当前effect
        effectStack.push(effect)
        //+  effect 放入 effectStack
        activeEffect = effect
        return fn()
      } finally {
        // 执行完毕
        effectStack.pop()
        //+ 激活effect返回之前的状态
        //+ 恢复上一次effect信息，即本次允许追踪信息出栈
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  effect.id = uid++
  //+ 自增id， 唯一标识effect
  effect.allowRecurse = !!options.allowRecurse
  //+ 是否允许递归（允许循环调用自己）
  effect._isEffect = true
  effect.active = true
  //+ 是否激活
  effect.raw = fn
  effect.deps = []
  //+ 持有当前 effect 的dep 数组
  effect.options = options
  //+ 入参
  return effect
}

// 清除副作用的依赖
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  //+ deps 是持有 effect 的依赖数组
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      //+ 此时清除的是什么
      //+ delete的是这次track会触发那些effect，把这个在执行的effect从这次track中去除，避免重复触发
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 询问targetMap有没有该target（引用属性），没有则设置target为键，value为空的Map，depsMap。
// 查看value存在不存在key，不存在则创建一个空的Set，dep。
// 查看dep存在不存在effect，不存在则存放当前activeEffect，給当前activeEffect.deps.push(dep)。
// 一个全局收集器收集target，key，activeEffect，由于追踪响应行为的是key，所以在key的层级存放activeEffect。
// 如果用对象来描述Map 用数组描述Set，那么以下就是当前测试变量a得出的结果
// { target: { key: [ activeEffect ] } }
export function track(target: object, type: TrackOpTypes, key: unknown) {
  //+ 依赖收集进行的前置条件：
  // 1. 全局收集标识开启
  // 2. 存在激活的副作用
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  //+ 创建依赖收集map target ---> deps ---> effect
  //+ key 对应的effect
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    //+ init
    targetMap.set(target, (depsMap = new Map()))
  }
  let dep = depsMap.get(key)
  if (!dep) {
    //+ init
    depsMap.set(key, (dep = new Set()))
  }
  //+  key 的 依赖 Set 集合 不包括当前激活副作用
  if (!dep.has(activeEffect)) {
    //+ 依赖收集副作用
    dep.add(activeEffect)
    //+ 副作用中保存当前依赖Set（dep存储的是这个target下所有的effect）
    //+ 方便effect clean的时候快速删除
    activeEffect.deps.push(dep)
    // Set<ReactiveEffect>
    // 开发环境触发收集的hooks
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  // Map<any, Set<ReactiveEffect>>
  if (!depsMap) {
    // never been tracked
    return
  }

  const effects = new Set<ReactiveEffect>()
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        //+ 不是当前激活的副作用或者允许自执行的才被加入到集合中
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  //+ 收集各种触发条件下的副作用
  if (type === TriggerOpTypes.CLEAR) {
    //+ Map或Set被清空时需要调用整个target对应的所有effect
    //+ 测试用例在reactivity/__test__/collections/Map.sepc.ts
    //+ 全局搜索 'should observe size mutations'
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    //+ taregt是数组的情况下 我们修改其length长度，是一种修改操作
    //+ 数组长度变更，触发length的track或者索引在后的
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    //+ 直接添加所有有依赖的副作用函数
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          //+ 触发原值的迭代器事件
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            //+ map的迭代器事件
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          //+ 添加新的index，触发的更新是length
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          // 同上
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        //+ 其他情况已经在这个else的头部处理了
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      //+ 渲染processComponent的时候在setupRenderEffect方法中，
      //+ instance.update = effect(()=>{}, prodEffectOptions)
      //+ 最终相当于是queueJob(effect)
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }

  effects.forEach(run)
}
