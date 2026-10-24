import type { VenueSettings } from './settings'

/**
 * The version of the privacy policy and default user agreement below: their date, with `.2` and
 * so on for a later change the same day. Change it whenever either text changes in substance:
 * students who agreed to an older version are asked again.
 */
export const POLICY_VERSION = '2026-10-24.2'

/** The date the texts show. */
const POLICY_DATE = POLICY_VERSION.slice(0, 10)

/** Who runs the mini program and how to reach them, falling back to the venue's own details. */
function operator(s: VenueSettings) {
  return {
    name: s.legal.operator.trim() || s.venue.name,
    contact: s.legal.contact.trim() || s.venue.phone || '场馆前台',
  }
}

/**
 * The privacy policy. It is built in rather than written in settings, because it has to match
 * what the code actually collects; only the operator and contact come from settings.
 */
export function privacyPolicyText(s: VenueSettings): string {
  const op = operator(s)
  return `更新日期：${POLICY_DATE}

${op.name}（以下简称“我们”）运营本小程序，为你提供乒乓球课程的预约、支付和上课管理。本政策说明我们处理哪些个人信息、为什么处理以及你的权利。

一、我们收集的信息
1. 微信登录标识（openid）：打开小程序时自动获取，用于识别你的账号。我们不获取你的微信昵称、头像或好友信息。
2. 姓名和手机号：首次预约时由你填写，用于上课签到、课程变动时联系你。
3. 预约和上课记录：预约的课程、时间、教练、取消和到课情况，教练为上课所做的备注，以及教练写给你的课后点评和课堂照片。
4. 订单和支付记录：金额、支付状态、微信支付交易单号和退款记录。我们无法获取你的银行卡或微信钱包信息。
5. 订阅消息：你同意接收后，我们按你的选择发送预约和课程通知。
6. 发票信息：申请发票时由你填写的抬头、税号和接收邮箱，用于开具和发送发票。

二、我们如何使用
仅用于提供预约、上课、支付、退款、课程通知和客户服务，以及依法需要保存的记录。我们不会将你的信息用于广告，也不会出售给任何人。

三、共享和委托处理
1. 微信支付（财付通支付科技有限公司）：处理付款和退款。
2. 腾讯云：存储小程序数据，服务器位于中国境内。
3. 本场馆教练：可查看所授课程学员的姓名、手机号和上课记录，并为到课的课程写课后点评、上传课堂照片。
除以上情况和法律要求外，我们不会向他人提供你的个人信息。

四、使用的系统功能
1. 剪贴板：在你点击场馆地址时写入地址，便于粘贴到地图应用。我们不读取剪贴板。
2. 地图：打开微信内置地图显示场馆位置。我们不获取你的位置。
3. 相册和相机：教练写课后点评时，可从相册选择或拍摄照片上传。只上传教练选中的照片，我们不读取相册中的其他内容。

五、保存期限
账号存续期间保存你的信息。注销账号后，我们删除你的姓名、手机号、微信登录标识、教练备注、课后点评和课堂照片、发票邮箱和个人抬头的发票；订单、支付和退款记录按会计和税务法规要求匿名保存，到期后删除。

六、你的权利
1. 查看和修改：在“我的 > 个人信息”中查看和修改姓名、手机号。
2. 注销账号：在“我的 > 个人信息 > 注销账号”中操作。注销后无法恢复。
3. 撤回同意：你可以注销账号，或联系我们删除信息。撤回不影响此前已进行的处理。
4. 其他请求可通过下方方式联系我们，我们会在 15 个工作日内答复。

七、未成年人
未满 14 周岁的学员，请由父母或其他监护人阅读本政策，并由监护人填写信息和预约。

八、政策更新
本政策有重要变化时，我们会在小程序中提示，并再次征得你的同意。

九、联系我们
${op.name}
联系方式：${op.contact}${s.venue.address ? `\n地址：${s.venue.address}` : ''}`
}

/** The user agreement shown when the venue has not written its own in settings. */
export function defaultAgreementText(s: VenueSettings): string {
  const op = operator(s)
  return `更新日期：${POLICY_DATE}

本协议是你与${op.name}（以下简称“场馆”）之间关于使用本小程序预约课程的约定。

一、服务内容
你可以在本小程序中查看课程和教练，预约、支付和取消课程，购买和使用课时包。

二、账号
1. 你使用微信身份登录，请如实填写上课学员的姓名和手机号。
2. 未满 18 周岁的学员，应由监护人同意并代为预约。

三、预约和取消
1. 预约以小程序显示的预约成功为准。
2. 取消规则见“预约须知”和预约页面的说明。逾期取消或未到课，按规则不退或部分退还费用和课时。
3. 场馆或教练因故取消课程时，全额退款或退回课时。

四、课时包
1. 课时包仅限本人使用，不可转让。
2. 课时包须在有效期内使用，过期后剩余课时失效。
3. 未使用的课时可申请退款，由场馆审核后退回。

五、上课安全
请根据自身身体状况参加训练，按教练指导进行练习。如有不适，请立即停止并告知教练。

六、协议变更
协议有重要变化时，我们会在小程序中提示，并再次征得你的同意。

七、联系我们
${op.name}，联系方式：${op.contact}`
}
