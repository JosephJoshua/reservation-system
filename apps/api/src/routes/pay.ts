import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { orders } from '../db/schema'
import type { Deps } from '../deps'
import { ApiError, idParam, notFound } from '../errors'
import type { FakeGateway } from '../pay/fake'
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

/** Development only: lets the mini program finish a payment against the fake gateway. */
export function devPayRoutes(deps: Deps, gateway: FakeGateway) {
  const app = new Hono()
  app.post('/dev/fake-pay/:orderId', (c) => {
    const order = deps.db
      .select()
      .from(orders)
      .where(eq(orders.id, idParam(c, 'orderId')))
      .get()
    if (!order) throw notFound('订单')
    const outTradeNo = order.outTradeNo
    let result: ReturnType<FakeGateway['pay']>
    try {
      result = gateway.pay(outTradeNo, deps.now())
    } catch (e) {
      throw new ApiError(409, 'fake_pay_failed', (e as Error).message)
    }
    if (result.order.state === 'paid') applyPayment(deps, outTradeNo, result.order)
    return c.body(null, 204)
  })
  return app
}
