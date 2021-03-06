import 'core-js/es7/symbol'
import * as ko from 'knockout'
import { IContext } from './'
import { Route } from './route'
import { Router, Middleware } from './router'
import {
  Callback,
  isThenable, isUndefined,
  concat,
  extend,
  map,
  castLifecycleObjectMiddlewareToGenerator,
  sequence
} from './utils'

export class Context implements IContext {
  public $child: Context & IContext
  public $parent: Context & IContext
  public router: Router
  public route: Route
  public params: { [k: string]: any }
  public path: string
  public pathname: string
  public _redirect: string
  public _redirectArgs: {
    push: false
    force?: boolean
    with?: { [prop: string]: any }
  }

  private _queue: Promise<void>[]  = []
  private _beforeNavigateCallbacks: Callback<void>[] = []
  private _appMiddlewareDownstream: Callback<void>[] = []
  private _routeMiddlewareDownstream: Callback<void>[] = []

  constructor(router: Router, $parent: Context, path: string, _with: { [key: string]: any } = {}) {
    const route = router.resolveRoute(path)
    const { params, pathname, childPath } = route.parse(path)

    extend(this, {
      $parent,
      params,
      path,
      pathname,
      route,
      router
    }, _with)

    if ($parent) {
      $parent.$child = this
    }
    if (childPath) {
      // tslint:disable-next-line no-unused-expression
      new Router(childPath, this).ctx
    }
  }

  public addBeforeNavigateCallback(cb: Callback<void>) {
    this._beforeNavigateCallbacks.unshift(cb)
  }

  public get base(): string {
    return this.router.isRoot
      ? Router.base
      : this.$parent.base + this.$parent.pathname
  }

  // full path w/o base
  public get canonicalPath() {
    return this.base.replace(new RegExp(this.$root.base, 'i'), '') + this.pathname
  }

  public get $root(): Context & IContext {
    let ctx: Context & IContext = this
    while (ctx) {
      if (ctx.$parent) {
        ctx = ctx.$parent
      } else {
        return ctx
      }
    }
  }

  public get $parents(): (Context & IContext)[] {
    const parents = []
    let parent = this.$parent
    while (parent) {
      parents.push(parent)
      parent = parent.$parent
    }
    return parents
  }

  public get $children(): (Context & IContext)[] {
    const children = []
    let child = this.$child
    while (child) {
      children.push(child)
      child = child.$child
    }
    return children
  }

  public queue(promise: Promise<void>) {
    this._queue.push(promise)
  }

  public redirect(path: string, args: { [k: string]: any } = {}) {
    this._redirect = path
    this._redirectArgs = extend({}, args, { push: false as false })
  }

  public async runBeforeNavigateCallbacks(): Promise<boolean> {
    let ctx: Context = this
    let callbacks: Callback<boolean | void>[] = []
    while (ctx) {
      callbacks = [...ctx._beforeNavigateCallbacks, ...callbacks]
      ctx = ctx.$child
    }
    const { success } = await sequence(callbacks)
    return success
  }

  public render() {
    let ctx: Context = this
    while (ctx) {
      if (isUndefined(ctx._redirect)) {
        ctx.router.component(ctx.route.component)
      }
      ctx = ctx.$child
    }
    ko.tasks.runEarly()
  }

  public async runBeforeRender(flush = true) {
    const appMiddlewareDownstream = Context.runMiddleware(Router.middleware, this)
    const routeMiddlewareDownstream = Context.runMiddleware(this.route.middleware, this)

    const { count: numAppMiddlewareRanPreRedirect } = await sequence(appMiddlewareDownstream)
    const { count: numRouteMiddlewareRanPreRedirect } = await sequence(routeMiddlewareDownstream)

    this._appMiddlewareDownstream = appMiddlewareDownstream.slice(0, numAppMiddlewareRanPreRedirect)
    this._routeMiddlewareDownstream = routeMiddlewareDownstream.slice(0, numRouteMiddlewareRanPreRedirect)

    if (this.$child && isUndefined(this._redirect)) {
      await this.$child.runBeforeRender(false)
    }
    if (flush) {
      await this.flushQueue()
    }
  }

  public async runAfterRender() {
    await sequence(concat(this._appMiddlewareDownstream, this._routeMiddlewareDownstream))
    await this.flushQueue()
  }

  public async runBeforeDispose(flush = true) {
    if (this.$child && isUndefined(this._redirect)) {
      await this.$child.runBeforeDispose(false)
    }
    await sequence(concat(this._routeMiddlewareDownstream, this._appMiddlewareDownstream))
    if (flush) {
      await this.flushQueue()
    }
  }

  public async runAfterDispose(flush = true) {
    if (this.$child && isUndefined(this._redirect)) {
      await this.$child.runAfterDispose(false)
    }
    await sequence(concat(this._routeMiddlewareDownstream, this._appMiddlewareDownstream))
    if (flush) {
      await this.flushQueue()
    }
  }

  private async flushQueue() {
    const thisQueue = Promise.all(this._queue).then(() => {
      this._queue = []
    })
    const childQueues = map(this.$children, (c) => c.flushQueue())
    await Promise.all<Promise<void>>([thisQueue, ...childQueues])
  }

  private static runMiddleware(middleware: Middleware[], ctx: Context): Callback<void>[] {
    return map(middleware, (fn) => {
      const runner = castLifecycleObjectMiddlewareToGenerator(fn)(ctx)
      let beforeRender = true
      return async () => {
        const ret = runner.next()
        if (isThenable(ret)) {
          await ret
        } else if (isThenable((ret as IteratorResult<Promise<void> | void>).value)) {
          await (ret as IteratorResult<Promise<void> | void>).value
        }
        if (beforeRender) {
          // this should only block the sequence for the first call,
          // and allow cleanup after the redirect
          beforeRender = false
          return isUndefined(ctx._redirect)
        } else {
          return true
        }
      }
    })
  }
}
