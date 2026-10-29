import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { orders } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, notFound } from '../errors'
import type { FakeGateway } from '../pay/fake'
import { type AuthVars, requireStudent } from '../services/auth'
import { applyPayment } from '../services/orders'
import { settleRefund } from '../services/refunds'

/** WeChat Pay callbacks. A non-2xx answer makes WeChat Pay retry later. */
export function payRoutes(deps: Deps) {
  const app = new Hono()

  app.post('/pay/wechat/notify', async (c) => {
    const body = await c.req.text()
    try {
      const { outTradeNo, order } = deps.gateway.parsePaymentNotification(c.req.raw.headers, body)
      if (order.state === 'paid') {
        try {
          applyPayment(deps, outTradeNo, order)
        } catch (e) {
          // A verified callback for an order this database never had (another environment on the
          // same merchant, or a restored backup) can never succeed, so stop WeChat retrying it.
          if (!(e instanceof ApiError && e.status === 404)) throw e
          deps.log('payment callback for an unknown order', { outTradeNo })
        }
      }
      return c.body(null, 204)
    } catch (e) {
      deps.log('payment callback rejected', (e as Error).message)
      return c.json({ code: 'FAIL', message: '处理失败' }, 500)
    }
  })

  app.post('/pay/wechat/refund-notify', async (c) => {
    const body = await c.req.text()
    try {
      const { outRefundNo, refund } = deps.gateway.parseRefundNotification(c.req.raw.headers, body)
      settleRefund(deps, outRefundNo, refund)
      return c.body(null, 204)
    } catch (e) {
      deps.log('refund callback rejected', (e as Error).message)
      return c.json({ code: 'FAIL', message: '处理失败' }, 500)
    }
  })

  return app
}

/**
 * Development and staging only: lets the mini program finish a payment against the fake gateway.
 * Only the signed-in student who owns the order can pay it, as in the real cashier. With
 * `?callback=lost` the payment is taken but the API is not told, as when WeChat Pay's callback is
 * late or lost, so QA can check that the student still sees it.
 */
export function devPayRoutes(deps: Deps, gateway: FakeGateway) {
  const app = new Hono<AuthVars>()
  app.post('/dev/fake-pay/:orderId', requireStudent(deps), (c) => {
    const order = deps.db
      .select()
      .from(orders)
      .where(eq(orders.id, idParam(c, 'orderId')))
      .get()
    if (!order || order.studentId !== c.get('studentId')) throw notFound('订单')
    const outTradeNo = order.outTradeNo
    let result: ReturnType<FakeGateway['pay']>
    try {
      result = gateway.pay(outTradeNo, deps.now())
    } catch {
      // Real WeChat Pay refuses a closed order in the cashier; say so in the same words.
      throw new ApiError(409, 'fake_pay_failed', '订单已失效，请重新预约')
    }
    if (result.order.state === 'paid' && c.req.query('callback') !== 'lost') {
      applyPayment(deps, outTradeNo, result.order)
    }
    return c.body(null, 204)
  })
  return app
}
