import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { orders } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, notFound, parseBody } from '../errors'
import { type FakeGateway, fakeRefundModes } from '../pay/fake'
import { GatewayError } from '../pay/gateway'
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
      // Meant for another app or merchant: retrying would never make it ours.
      if (e instanceof GatewayError && e.code === 'FOREIGN_NOTIFICATION') {
        deps.log('payment callback for another merchant ignored', e.message)
        return c.body(null, 204)
      }
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
 * late or lost, so QA can check that the student still sees it. `?as=mismatch` reports another
 * amount and `?as=refunded` an order already refunded at WeChat Pay, which staff then see as
 * 支付异常.
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
      const as = c.req.query('as')
      result = gateway.pay(
        outTradeNo,
        deps.now(),
        as === 'mismatch' || as === 'refunded' ? as : undefined,
      )
    } catch {
      // Real WeChat Pay refuses a closed order in the cashier; say so in the same words.
      throw new ApiError(409, 'fake_pay_failed', '订单已失效，请重新预约')
    }
    if (result.order.state === 'paid' && c.req.query('callback') !== 'lost') {
      applyPayment(deps, outTradeNo, result.order)
    }
    return c.body(null, 204)
  })
  // How the fake gateway answers the next refunds, for QA of failed, ABNORMAL and unknown ones.
  app.post('/dev/fake-refund-mode', requireStudent(deps), async (c) => {
    const { mode } = await parseBody(c, z.object({ mode: z.enum(fakeRefundModes) }))
    gateway.refundMode = mode
    return c.body(null, 204)
  })
  return app
}
