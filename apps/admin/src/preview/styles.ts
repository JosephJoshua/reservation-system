import app from '@mp/app.wxss'
import themeRoot from '@mp/components/theme-root/index.wxss'
import book from '@mp/pages/book/index.wxss'
import booking from '@mp/pages/booking/index.wxss'
import coachDetail from '@mp/pages/coach-detail/index.wxss'
import packages from '@mp/pages/packages/index.wxss'
import avatar from 'tdesign-miniprogram/miniprogram_dist/avatar/avatar.wxss'
import button from 'tdesign-miniprogram/miniprogram_dist/button/button.wxss'
import cell from 'tdesign-miniprogram/miniprogram_dist/cell/cell.wxss'
import cellGroup from 'tdesign-miniprogram/miniprogram_dist/cell-group/cell-group.wxss'
import empty from 'tdesign-miniprogram/miniprogram_dist/empty/empty.wxss'
import noticeBar from 'tdesign-miniprogram/miniprogram_dist/notice-bar/notice-bar.wxss'
import tag from 'tdesign-miniprogram/miniprogram_dist/tag/tag.wxss'

/** The theme, the TDesign components the screens use and the theme wrapper, for every screen. */
export const baseStyles = { app, avatar, button, cell, cellGroup, empty, noticeBar, tag, themeRoot }

/** Each page's own wxss. Pages reuse class names, so only the shown page's styles are added. */
export const pageStyles = { booking, book, coachDetail, packages }
