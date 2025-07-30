/* eslint-disable */
// 移植自 https://github.com/stackblitz/alien-signals/blob/v2.0.4/src/system.ts
// alien-signals 是一个高性能的响应式信号库，Vue 3.6 将其作为新的响应式系统核心
import type { ComputedRefImpl as Computed } from './computed.js'
import type { ReactiveEffect as Effect } from './effect.js'
import type { EffectScope } from './effectScope.js'
import { warn } from './warning.js'

// 辅助函数：获取节点名称
function getNodeName(node: any): string {
  if (!node) return 'null'
  if (
    ['SetupRenderEffect', 'RenderWatcherEffect'].includes(
      node.constructor?.name,
    )
  ) {
    // 特殊处理最终展示依赖
    return node.constructor.name
  }
  if (node.name) return node.name
  if (node.fn?.name) return node.fn.name
  if (node.constructor?.name) return node.constructor.name
  if (node._rawValue !== undefined) return `ref(${node._rawValue})`
  return 'unknown'
}

// 判断是否是用户代码相关的节点
function isUserCodeNode(node: any): boolean {
  if (!node) return false
  const nodeName = getNodeName(node)
  // Vue 内部节点（需要过滤掉的）
  const internalPatterns = [
    'EffectScope',
    'fn',
    'renderComponentRoot',
    'instance',
    'ReactiveEffect',
    'Dep',
    'bound containerVisible',
  ]
  return !internalPatterns.some(pattern => nodeName.includes(pattern))
}

// 辅助函数：格式化标志位(简单)
export function formatFlagsSimple(flags: number): string {
  const names: string[] = []
  if (flags & ReactiveFlags.Mutable) names.push(`Mutable`)
  if (flags & ReactiveFlags.Watching) names.push(`Watching`)
  if (flags & ReactiveFlags.RecursedCheck) {
    names.push(`RecursedCheck`)
  }
  if (flags & ReactiveFlags.Recursed) names.push(`Recursed`)
  if (flags & ReactiveFlags.Dirty) names.push(`Dirty`)
  if (flags & ReactiveFlags.Pending) names.push(`Pending`)
  // return ''
  return `(${names.join('|') || 'None'})`
}

// 辅助函数：格式化标志位
export function formatFlags(flags: number): string {
  const names: string[] = []
  if (flags & ReactiveFlags.Mutable) names.push(`Mutable(可变的)`)
  if (flags & ReactiveFlags.Watching) names.push(`Watching(监听中)`)
  if (flags & ReactiveFlags.RecursedCheck) {
    names.push(`RecursedCheck(递归检查中)`)
  }
  if (flags & ReactiveFlags.Recursed) names.push(`Recursed(已递归处理)`)
  if (flags & ReactiveFlags.Dirty) names.push(`Dirty(脏数据)`)
  if (flags & ReactiveFlags.Pending) names.push(`Pending(等待处理)`)
  return names.join('|') || 'None'
}

let trackingDepth = -1
const trackingBlanks = () => {
  return new Array(trackingDepth).fill('    ').join('')
}

// 内部调试函数：打印链表结构
function debugPrintLinkStructure(
  nodes: any[],
  title: string = '链表结构快照',
): void {
  if (nodes.length === 0) {
    return
  }

  nodes.forEach(node => {
    printNodeStatus(node) // subscriber de
  })
}

// 辅助函数：打印完整的节点状态
function printNodeStatus(node: any) {
  if (!isUserCodeNode(node)) {
    return
  }

  const nodeName = `${getNodeName(node)}${formatFlagsSimple(node.flags)}`

  // console.info(node)

  if (node.deps) {
    let result = ''
    let current = node.deps
    let _current = current
    while (current) {
      const depName = `${getNodeName(current.dep)}${formatFlagsSimple(current.dep.flags)}`
      const subName = `${getNodeName(current.sub)}${formatFlagsSimple(current.sub.flags)}`
      const nextPointer = current.nextDep
      if (isUserCodeNode(depName) && isUserCodeNode(subName)) {
        result = `${result} \x1b[32mLink\x1b[0m{dep:${depName},sub:${subName}}${nextPointer ? '\x1b[31m --nextDep-->\x1b[0m' : ''}`
      }
      _current = current
      current = nextPointer
    }
    result = `${result}\x1b[31m --dep--> \x1b[0m\x1b[34mSignal(${getNodeName(_current.dep)})\x1b[0m`
    if (result) {
      console.info(
        `${trackingBlanks()}📋 \x1b[31mSignal(${nodeName})\x1b[0m{_value:${(node as any)._value ?? 'N/A'}}\x1b[31m --deps-->\x1b[0m${result}`,
      )
    }
  }

  if (node.subs) {
    let result = ''
    let current = node.subs
    let _current = current
    while (current) {
      const depName = `${getNodeName(current.dep)}${formatFlagsSimple(current.dep.flags)}`
      const subName = `${getNodeName(current.sub)}${formatFlagsSimple(current.sub.flags)}`
      const nextPointer = current.nextSub
      if (isUserCodeNode(current.dep) && isUserCodeNode(current.sub)) {
        result = `${result} \x1b[32mLink\x1b[0m{dep:${depName},sub:${subName}}${nextPointer ? '\x1b[34m --nextSub-->\x1b[0m' : ''}`
      }
      _current = current
      current = nextPointer
    }
    result = `${result}\x1b[34m --sub--> \x1b[0m\x1b[31mSignal(${getNodeName(_current.sub)})\x1b[0m`
    if (result) {
      console.info(
        `${trackingBlanks()}📋 \x1b[34mSignal(${nodeName})\x1b[0m{_value:${(node as any)._value ?? 'N/A'}}\x1b[34m --subs-->\x1b[0m${result}`,
      )
    }
  }
}

/**
 * 响应式节点接口
 * 所有响应式对象（ref、computed、effect）都实现这个接口
 *
 * 核心思想：每个节点维护两个双向链表
 * - deps 链表：记录我依赖的所有节点
 * - subs 链表：记录依赖我的所有节点
 */
export interface ReactiveNode {
  deps?: Link // 我依赖的链表头（dependency list）
  depsTail?: Link // 我依赖的链表尾，用于 O(1) 插入
  subs?: Link // 依赖我的链表头（subscriber list）
  subsTail?: Link // 依赖我的链表尾，用于 O(1) 插入
  flags: ReactiveFlags // 状态标志位，用位运算快速判断状态
}

/**
 * 链表节点接口，表示一条依赖关系
 * 每个 Link 连接一个依赖者（dep）和订阅者（sub）
 *
 * 双向链表设计：
 * - 在 dep.subs 链表中：prevSub <-> Link <-> nextSub
 * - 在 sub.deps 链表中：prevDep <-> Link <-> nextDep
 */
export interface Link {
  dep: ReactiveNode | Computed | Effect | EffectScope // 被依赖者（dependency）
  sub: ReactiveNode | Computed | Effect | EffectScope // 订阅者（subscriber）
  prevSub: Link | undefined // 在 dep.subs 链表中的前一个节点
  nextSub: Link | undefined // 在 dep.subs 链表中的下一个节点
  prevDep: Link | undefined // 在 sub.deps 链表中的前一个节点
  nextDep: Link | undefined // 在 sub.deps 链表中的下一个节点
}

/**
 * 栈结构，用于避免递归调用
 * 在 propagate 和 checkDirty 中使用，防止爆栈
 */
interface Stack<T> {
  value: T
  prev: Stack<T> | undefined
}

/**
 * 响应式标志位枚举
 * 使用位运算进行快速状态检查和更新
 */
export const enum ReactiveFlags {
  None = 0, // 000000
  Mutable = 1 << 0, // 000001 1: 可变的（computed、ref）
  Watching = 1 << 1, // 000010 2: 监听中（effect）
  RecursedCheck = 1 << 2, // 000100 4: 递归检查中，用于依赖追踪
  Recursed = 1 << 3, // 001000 8: 已递归处理，防止重复处理
  Dirty = 1 << 4, // 010000 16: 脏数据，需要重新计算
  Pending = 1 << 5, // 100000 32: 等待处理，已标记但未执行
}

// 通知缓冲区：收集需要执行的 effect，批量处理提升性能
const notifyBuffer: (Effect | undefined)[] = []

// 批处理深度：嵌套的 startBatch/endBatch 调用计数
export let batchDepth = 0

// 当前活跃的订阅者：用于依赖收集
export let activeSub: ReactiveNode | undefined = undefined

// 通知缓冲区的索引和长度
let notifyIndex = 0
let notifyBufferLength = 0

/**
 * 设置当前活跃的订阅者
 * 使用 try-finally 确保状态恢复，即使发生异常也能正确恢复
 *
 * @param sub 新的活跃订阅者
 * @returns 之前的活跃订阅者
 */
export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  try {
    return activeSub
  } finally {
    activeSub = sub
  }
}

/**
 * 开始批处理
 * 增加批处理深度，嵌套调用时不会立即执行通知
 */
export function startBatch(): void {
  ++batchDepth
}

/**
 * 结束批处理
 * 减少批处理深度，当深度为 0 且有待处理通知时，执行 flush
 */
export function endBatch(): void {
  if (!--batchDepth && notifyBufferLength) {
    flush()
  }
}

/**
 * 建立依赖关系的核心函数
 * 在依赖者（dep）和订阅者（sub）之间建立双向链接
 *
 * 优化要点：
 * 1. 去重检查：避免重复链接同一个依赖
 * 2. 递归优化：利用 RecursedCheck 标志快速查找
 * 3. O(1) 插入：使用链表尾指针快速插入
 *
 * @param dep 被依赖者（dependency）
 * @param sub 订阅者（subscriber）
 */
export function link(dep: ReactiveNode, sub: ReactiveNode): void {
  // 只在涉及用户代码时显示链接信息
  if (isUserCodeNode(dep) && isUserCodeNode(sub)) {
    console.info(
      `${trackingBlanks()}[\x1b[91m依赖收集\x1b[0m] 🔗 建立依赖关系: ${getNodeName(dep)} 被 ${getNodeName(sub)} 订阅`,
    )
  }

  // 检查是否已经存在相同的依赖关系
  const prevDep = sub.depsTail
  if (prevDep !== undefined && prevDep.dep === dep) {
    if (isUserCodeNode(dep) || isUserCodeNode(sub)) {
      console.info(`${trackingBlanks()}❌ 已存在相同依赖，跳过`)
    }
    return // 已存在，直接返回
  }

  let nextDep: Link | undefined = undefined
  const recursedCheck = sub.flags & ReactiveFlags.RecursedCheck

  // 尝试找到现有的链接进行复用
  if (recursedCheck) {
    nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
    if (nextDep !== undefined && nextDep.dep === dep) {
      sub.depsTail = nextDep
      if (isUserCodeNode(dep) || isUserCodeNode(sub)) {
        console.info(`${trackingBlanks()}✅ 在递归检查中找到现有链接，复用`)
      }
      return
    }
  }

  // 检查 dep 的订阅者列表中是否已有相同的订阅
  const prevSub = dep.subsTail
  if (
    prevSub !== undefined &&
    prevSub.sub === sub &&
    (!recursedCheck || isValidLink(prevSub, sub))
  ) {
    if (isUserCodeNode(dep) || isUserCodeNode(sub)) {
      console.info(`${trackingBlanks()}✅ 找到有效的现有订阅，跳过`)
    }
    return
  }

  // 创建新的链接节点
  const newLink: Link = {
    dep,
    sub,
    prevDep,
    nextDep,
    prevSub,
    nextSub: undefined,
  }

  // 同时更新 sub.depsTail 和 dep.subsTail
  sub.depsTail = newLink
  dep.subsTail = newLink

  // 更新 sub 的 deps 链表
  if (nextDep !== undefined) {
    nextDep.prevDep = newLink
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = newLink
  } else {
    sub.deps = newLink // 如果是第一个依赖，设置为链表头
  }

  // 更新 dep 的 subs 链表
  if (prevSub !== undefined) {
    prevSub.nextSub = newLink
  } else {
    dep.subs = newLink // 如果是第一个订阅者，设置为链表头
  }

  if (isUserCodeNode(dep) && isUserCodeNode(sub)) {
    debugPrintLinkStructure(
      [dep, sub],
      `链接建立后结构: ${getNodeName(dep)} -> ${getNodeName(sub)}`,
    )
    console.info(`${trackingBlanks()}✅ 新链接创建成功!`)
  }
}

/**
 * 断开依赖关系
 * 从双向链表中移除指定的链接
 *
 * @param link 要断开的链接
 * @param sub 订阅者，默认为 link.sub
 * @returns 下一个依赖链接（用于遍历）
 */
export function unlink(
  link: Link,
  sub: ReactiveNode = link.sub,
): Link | undefined {
  const dep = link.dep
  const prevDep = link.prevDep
  const nextDep = link.nextDep
  const nextSub = link.nextSub
  const prevSub = link.prevSub

  // 从 sub.deps 链表中移除
  if (nextDep !== undefined) {
    nextDep.prevDep = prevDep
  } else {
    sub.depsTail = prevDep // 如果是尾节点，更新尾指针
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = nextDep
  } else {
    sub.deps = nextDep // 如果是头节点，更新头指针
  }

  // 从 dep.subs 链表中移除
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub
  } else {
    dep.subsTail = prevSub // 如果是尾节点，更新尾指针
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub
  } else if ((dep.subs = nextSub) === undefined) {
    // 如果 dep 没有订阅者了，递归清理其依赖
    let toRemove = dep.deps
    if (toRemove !== undefined) {
      do {
        toRemove = unlink(toRemove, dep)
      } while (toRemove !== undefined)
      dep.flags |= ReactiveFlags.Dirty // 标记为脏数据
    }
  }

  return nextDep
}

/**
 * 依赖传播的核心函数
 * 当依赖发生变化时，传播更新到所有订阅者
 *
 * 核心算法：
 * 1. 使用栈结构避免递归调用
 * 2. 精确的状态转换逻辑
 * 3. 批处理机制：将 effect 添加到 notifyBuffer
 *
 * @param link 开始传播的链接
 */
export function propagate(link: Link): void {
  console.info(`📡 [PROPAGATE] ${getNodeName(link.dep)} 改变，开始传播`)

  let next = link.nextSub
  let stack: Stack<Link | undefined> | undefined
  let depth = 0

  top: do {
    const sub = link.sub
    let flags = sub.flags

    let indentation = ''
    for (let i = 0; i < depth; ++i) {
      indentation += '    '
    }

    console.info(`${indentation}🎯 处理节点 ${getNodeName(sub)}`)

    // 只处理 Mutable（computed/ref）或 Watching（effect）的节点
    if (flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
      let action = formatFlags(flags)

      // 状态转换逻辑：根据当前状态决定如何处理
      if (
        !(
          flags &
          (ReactiveFlags.RecursedCheck |
            ReactiveFlags.Recursed |
            ReactiveFlags.Dirty |
            ReactiveFlags.Pending)
        )
      ) {
        // 情况1：干净状态，直接标记为 Pending
        sub.flags = flags | ReactiveFlags.Pending
        action += ' -> Pending'
      } else if (
        !(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))
      ) {
        // 情况2：不在递归检查中，跳过处理
        flags = ReactiveFlags.None
        action += ' -> 跳过'
      } else if (!(flags & ReactiveFlags.RecursedCheck)) {
        // 情况3：清除递归标志，设置为 Pending
        sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending
        action += ' -> Pending'
      } else if (
        !(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
        isValidLink(link, sub)
      ) {
        // 情况4：在递归检查中且链接有效，标记为已递归和 Pending
        sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending
        flags &= ReactiveFlags.Mutable
        action += ' -> Recursed+Pending'
      } else {
        // 情况5：其他情况，跳过处理
        flags = ReactiveFlags.None
        action += ' -> 跳过'
      }

      console.info(`    ${indentation}📝 状态转换: ${action}`)

      // 如果是 effect（Watching），添加到通知缓冲区
      if (flags & ReactiveFlags.Watching) {
        notifyBuffer[notifyBufferLength++] = sub as Effect
        console.info(
          `    ${indentation}📢 添加到通知缓冲区(长度:${notifyBufferLength})`,
        )
        console.info(`    `, notifyBuffer)
      }

      // 如果是 computed（Mutable）且有订阅者，继续传播
      if (flags & ReactiveFlags.Mutable) {
        const subSubs = sub.subs
        if (subSubs !== undefined) {
          console.info(
            `    ${indentation}🔄 继续传播到 ${getNodeName(sub)} 的订阅者`,
          )
          link = subSubs
          if (subSubs.nextSub !== undefined) {
            // 有多个订阅者，使用栈保存当前状态
            stack = { value: next, prev: stack }
            next = link.nextSub
            console.info(`    ${indentation}📚 保存状态到栈 (多个订阅者)`)
          }
          depth++
          continue // 继续处理子订阅者
        }
      }
    }

    // 处理当前层级的下一个订阅者
    if ((link = next!) !== undefined) {
      next = link.nextSub
      console.info(
        `    ${indentation}➡️ 处理下一个订阅者: ${getNodeName(link.sub)}`,
      )
      continue
    }

    // 当前层级处理完毕，从栈中恢复状态
    while (stack !== undefined) {
      link = stack.value!
      stack = stack.prev
      depth--
      if (link !== undefined) {
        next = link.nextSub
        console.info(
          `    ${indentation}↩️ 从栈恢复状态 [深度${depth}]: ${getNodeName(link.sub)}`,
        )
        continue top
      }
    }

    break
  } while (true)

  console.info(`✅ 传播完成`)
}

/**
 * 开始依赖追踪
 * 为 effect 或 computed 的执行准备环境
 *
 * @param sub 订阅者节点
 * @returns 之前的活跃订阅者
 */
export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {
  trackingDepth++
  sub.depsTail = undefined
  sub.flags =
    (sub.flags &
      ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) |
    ReactiveFlags.RecursedCheck
  const preSub = setActiveSub(sub)
  console.log(
    `${trackingBlanks()}[\x1b[91m依赖收集 -- 开始\x1b[0m] ${getNodeName(preSub)} -> ${getNodeName(activeSub)}(\x1b[91mactiveSub\x1b[0m)`,
  )
  return preSub
}

/**
 * 结束依赖追踪
 * 清理无效的依赖关系，恢复之前的活跃订阅者
 *
 * @param sub 订阅者节点
 * @param prevSub 之前的活跃订阅者
 */
export function endTracking(
  sub: ReactiveNode,
  prevSub: ReactiveNode | undefined,
): void {
  if (__DEV__ && activeSub !== sub) {
    warn(
      'Active effect was not restored correctly - ' +
        'this is likely a Vue internal bug.',
    )
  }
  activeSub = prevSub
  console.log(
    `${trackingBlanks()}[\x1b[91m依赖收集 -- 结束\x1b[0m] ${getNodeName(sub)} -> ${getNodeName(prevSub)}(\x1b[91mactiveSub\x1b[0m)`,
  )

  // 清理追踪过程中新增的依赖
  const depsTail = sub.depsTail
  let toRemove = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (toRemove !== undefined) {
    toRemove = unlink(toRemove, sub)
  }
  sub.flags &= ~ReactiveFlags.RecursedCheck

  trackingDepth--
}

/**
 * 执行通知缓冲区中的所有 effect
 * 批处理机制的核心：统一执行所有待处理的 effect
 */
export function flush(): void {
  console.info(
    `📦 [FLUSH] 开始执行通知缓冲区 (${notifyBufferLength} 个 effect)`,
  )

  let executedCount = 0
  while (notifyIndex < notifyBufferLength) {
    const effect = notifyBuffer[notifyIndex]!
    notifyBuffer[notifyIndex++] = undefined

    console.info(
      `  🚀 执行 effect [${executedCount + 1}/${notifyBufferLength}]: ${getNodeName(effect)}`,
    )

    effect.notify() // 执行 effect
    executedCount++
  }

  notifyIndex = 0
  notifyBufferLength = 0

  console.info(`✅ 所有 effect 执行完成 (共 ${executedCount} 个)`)
}

/**
 * 检查依赖是否为脏数据
 * 用于 computed 的惰性求值：只有当依赖真正改变时才重新计算
 *
 * 核心算法：
 * 1. 使用栈结构避免递归
 * 2. 深度优先遍历依赖图
 * 3. 惰性求值：只在必要时触发计算
 *
 * @param link 要检查的依赖链接
 * @param sub 订阅者
 * @returns 是否为脏数据
 */
export function checkDirty(link: Link, sub: ReactiveNode): boolean {
  let stack: Stack<Link> | undefined
  let checkDepth = 0

  top: do {
    const dep = link.dep
    const depFlags = dep.flags

    let blanks = () => new Array(checkDepth + 1).fill('    ').join('')

    console.info(
      `${blanks()}[\x1b[34mcheckDirty\x1b[0m] 节点名称: ${getNodeName(dep)}-${(dep as any)._value ?? 'N/A'} | 节点状态: ${formatFlags(depFlags)}`,
    )

    let dirty = false

    // 检查订阅者本身是否为脏数据
    if (sub.flags & ReactiveFlags.Dirty) {
      dirty = true
    } else if (
      // 检查依赖是否为脏的可变节点
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
    ) {
      console.info(
        `${blanks()}[\x1b[34mcheckDirty\x1b[0m] 节点名称: ${getNodeName(dep)}-${(dep as any)._value ?? 'N/A'} 为 dirty 可变节点，执行依赖的更新，dirty 置为 \x1b[31mtrue\x1b[0m`,
      )
      // 执行依赖的更新
      if ((dep as Computed).update()) {
        const subs = dep.subs!
        if (subs.nextSub !== undefined) {
          shallowPropagate(subs) // 浅层传播
        }
        dirty = true
      }
    } else if (
      // 检查依赖是否为等待处理的可变节点
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Pending)
    ) {
      console.info(
        `${blanks()}[\x1b[34mcheckDirty\x1b[0m] 节点名称: ${getNodeName(dep)}-${(dep as any)._value ?? 'N/A'} 为 pending 可变节点，需要检查依赖的依赖`,
      )
      // 检查依赖的依赖
      if (link.nextSub !== undefined || link.prevSub !== undefined) {
        stack = { value: link, prev: stack }
      }
      link = dep.deps!
      sub = dep
      ++checkDepth
      continue
    }

    // 检查当前层级的下一个依赖
    if (!dirty && link.nextDep !== undefined) {
      link = link.nextDep
      continue
    }

    // 处理递归返回
    while (checkDepth) {
      --checkDepth
      const firstSub = sub.subs!
      const hasMultipleSubs = firstSub.nextSub !== undefined
      if (hasMultipleSubs) {
        link = stack!.value
        stack = stack!.prev
      } else {
        link = firstSub
      }
      if (dirty) {
        console.info(
          `${blanks()}[\x1b[34mcheckDirty\x1b[0m 递归回溯] 节点名称: ${getNodeName(sub)}-${(sub as any)._value ?? 'N/A'} 执行依赖的更新`,
        )
        if ((sub as Computed).update(blanks())) {
          if (hasMultipleSubs) {
            shallowPropagate(firstSub)
          }
          sub = link.sub
          continue
        }
      } else {
        sub.flags &= ~ReactiveFlags.Pending
      }
      sub = link.sub
      if (link.nextDep !== undefined) {
        link = link.nextDep
        continue top
      }
      console.info(
        `${blanks()}[\x1b[34mcheckDirty\x1b[0m 递归回溯] 节点名称: ${getNodeName(sub)}-${(sub as any)._value ?? 'N/A'} 订阅者无更新，dirty 置为 \x1b[32mfalse\x1b[0m`,
      )
      dirty = false
    }

    console.info(
      `${blanks()}[\x1b[34mcheckDirty\x1b[0m] 节点名称: ${getNodeName(sub)}-${(sub as any)._value ?? 'N/A'} dirty: ${dirty ? '\x1b[31mtrue\x1b[0m' : '\x1b[32mfalse\x1b[0m'}`,
    )

    return dirty
  } while (true)
}

/**
 * 浅层传播
 * 将 Pending 状态的节点标记为 Dirty
 *
 * @param link 开始传播的链接
 */
export function shallowPropagate(link: Link): void {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    const subFlags = sub.flags
    if (
      (subFlags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) ===
      ReactiveFlags.Pending
    ) {
      console.info(
        `${getNodeName(link.dep)} 的订阅者 ${getNodeName(sub)} 状态变 dirty`,
      )
      sub.flags = subFlags | ReactiveFlags.Dirty
    }
    link = nextSub!
  } while (link !== undefined)
}

/**
 * 检查链接是否有效
 * 用于验证依赖关系的正确性
 *
 * @param checkLink 要检查的链接
 * @param sub 订阅者
 * @returns 链接是否有效
 */
function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
  const depsTail = sub.depsTail
  if (depsTail !== undefined) {
    let link = sub.deps!
    do {
      if (link === checkLink) {
        return true
      }
      if (link === depsTail) {
        break
      }
      link = link.nextDep!
    } while (link !== undefined)
  }
  return false
}
