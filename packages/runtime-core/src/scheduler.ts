import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray } from '@vue/shared'
import { ComponentPublicInstance } from './componentPublicInstance'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'
import { ReactiveEffect } from '@vue/reactivity'

export interface SchedulerJob extends Function, Partial<ReactiveEffect> {
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerCb = Function & { id?: number }
export type SchedulerCbs = SchedulerCb | SchedulerCb[]

let isFlushing = false
let isFlushPending = false

//+ 异步任务队列
const queue: SchedulerJob[] = []
let flushIndex = 0

//+ 框架运行过程中产生的前置回调任务，比如一些特定的生命周期
//+ 这些回调任务是在主任务队列queue开始排空前批量排空执行的
const pendingPreFlushCbs: SchedulerCb[] = []
//+ 当前激活的前置回调任务
let activePreFlushCbs: SchedulerCb[] | null = null
let preFlushIndex = 0

//+ 框架运行过程中产生的后置回调任务，比如一些特定的生命周期（onMounted等）
//+ 这些回调任务是在主任务队列queue排空后批量排空执行的
const pendingPostFlushCbs: SchedulerCb[] = []
//+ 异步任务队列执行完成后的异步回调队列
let activePostFlushCbs: SchedulerCb[] | null = null
let postFlushIndex = 0

const resolvedPromise: Promise<any> = Promise.resolve()
let currentFlushPromise: Promise<void> | null = null

let currentPreFlushParentJob: SchedulerJob | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob | SchedulerCb, number>

export function nextTick(
  this: ComponentPublicInstance | void,
  fn?: () => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

//+ 调度系统的核心处理逻辑，将更新任务推入主任务队列，
//+ 同时会在合适的时机创建微任务，在微任务中执行任务并排空任务队列，做批量的更新工作。
//+ vue model层更新，并不是立即出发view更新的，原因上面我们也提到了，大量的同步更新，
//+ 比如一个由父到子的递归更新，函数调用栈会长时间占用主线程，导致线程阻塞无法执行其他更重要的任务。
//+ 因此vue将更新时产生的任务缓存到任务队列，在微任务中批量执行。
//+ 队列queue中没有任务A，则queue.push
// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(job: SchedulerJob) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length
  const jobId = getId(job)

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < jobId ? (start = middle + 1) : (end = middle)
  }

  return start
}

export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.

  //+ 主任务可入队逻辑：1. 队列为空 2. 正在清空队列（有正在执行的任务）且当前待入队任务是允许递归执行本身的，
  //+ 由于任务可能递归执行自身，该情况下待入队任务一定和当前执行任务是同一任务，
  //+ 因此待入队任务和正在执行任务相同，但不能和后面待执行任务相同
  //+ 3. 其他情况下，由于不会出现任务自身递归执行的情况，因此待入队任务不能和当前正在执行任务以及后面待执行任务相同。
  if (
    (!queue.length ||
      !queue.includes(
        job,
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {
    const pos = findInsertionIndex(job)
    if (pos > -1) {
      queue.splice(pos, 0, job)
    } else {
      queue.push(job)
    }
    queueFlush()
    //+ 标记队列准备执行，把flushJobs丢进微任务中。
  }
}

//+ 创建微任务，isFlushingPending和isFlushing时表示微任务已创建等待执行或者正在执行微任务，
//+ 这时候是会禁止再次创建更多的微任务，因为在主线程同步任务执行完后才会执行已创建的微任务，此时入队操作已完成，
//+ 并且flushJobs会在一次微任务中会递归的将主任务队列全部清空，所以只需要一个微任务即可，
//+ 如果重复创建微任务会导致接下来的微任务执行时队列是空的，那么这个微任务是无意义的，因为它不能清队。
function queueFlush() {
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    //+ 微任务创建成功，并记录当前微任务，作为nextTick创建自定义微任务的支点，也就是说，
    //+ nextTick创建出来的微任务执行顺序紧跟在清队微任务flushJobs后，保证自定义微任务执行时机的准确性
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

function queueCb(
  cb: SchedulerCbs,
  activeQueue: SchedulerCb[] | null,
  pendingQueue: SchedulerCb[],
  index: number
) {
  if (!isArray(cb)) {
    if (
      !activeQueue ||
      !activeQueue.includes(
        cb,
        (cb as SchedulerJob).allowRecurse ? index + 1 : index
      )
    ) {
      pendingQueue.push(cb)
    }
  } else {
    //+ 如果是一个数组，说明是组件hooks函数，这只能被唯一的一个job触发添加
    //+ 无需再次去重，跳过以提升性能
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingQueue.push(...cb)
  }
  queueFlush()
}

export function queuePreFlushCb(cb: SchedulerCb) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

export function queuePostFlushCb(cb: SchedulerCbs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]
    pendingPreFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      activePreFlushCbs[preFlushIndex]()
    }
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // recursively flush until it drains
    flushPreFlushCbs(seen, parentJob)
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob | SchedulerCb) =>
  job.id == null ? Infinity : job.id

//+ isFlushingPending状态表示清队微任务已创建，此时js主线程还可能会有其他的同步任务未执行完，
//+ 因此在主线程同步任务执行完毕前isFlushingPending一直为true，
//+ 当flushJobs开始执行时，表明清队微任务开始执行，
//+ 此时isFlushingPending置为false，isFlushing置为true，表示正在清队中。
//+ flushJob大致顺序如下： 批量清空前置回调任务队列 -> 清空主任务队列 -> 批量清空后置回调任务队列
function flushJobs(seen?: CountMap) {
  //+ 微任务启动，执行flushJobs，标记队列正在执行
  isFlushPending = false
  //+ 开始清队
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  //+ 前置任务执行
  flushPreFlushCbs(seen)

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  queue.sort((a, b) => getId(a) - getId(b))
  //+ 小到大 如果为null 则为Infinate effect的id 从小到大执行 因为effect 嵌套 是大到小被track收集的 BFS就是如此

  //+ 将主任务队列中的任务按照ID进行排序，原因：1. 组件更新是由父到子的，而更新任务是在数据源
  //+ 更新时触发的，trigger会执行effect中的scheduler，scheduler回调会把effect作为更新
  //+ 任务推入主任务队列，排序保证了更新任务是按照由父到子的顺序进行执行；
  //+ 2. 当一个组件父组件更新时执行卸载操作，任务排序确保了已卸载组件的更新会被跳过
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && checkRecursiveUpdates(seen!, job)) {
          continue
        }
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    //+ 主队列清空后执行后置回调任务
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    //+ 当前清队微任务执行完毕，重置currentFlushPromise、isFlushing
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    //+ 由于清队期间（isFlushing）也有可能会有任务入队，因此会导致按照实微任务开始执行时
    //+ 的队长度遍历清队，可能会导致无法彻底清干净。因此需要递归的清空队伍，保证一次清队微任务中所有任务队列都被全部清空
    //+ 循环调用直达执行完毕
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob | SchedulerCb) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = (fn as SchedulerJob).ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
