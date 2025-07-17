import type { MakeBilibiliGreatThanEverBeforeModule } from '../types'
import { tagged as css } from 'foxts/tagged'

const enhanceLive: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'enhance-live',
  description: '增强直播（自动切换最高画质）',
  onLive({ addStyle }) {
    // from https://greasyfork.org/zh-CN/scripts/467427-bilibili-%E8%87%AA%E5%8A%A8%E5%88%87%E6%8D%A2%E7%9B%B4%E6%92%AD%E7%94%BB%E8%B4%A8%E8%87%B3%E6%9C%80%E9%AB%98%E7%94%BB%E8%B4%A8
    ;(async function () {
      'use strict'

      // jump to actual room if live streaming is nested
      setInterval(() => {
        const nestedPage = document.querySelector('iframe[src*=blanc]')
        if (nestedPage) {
          ;(unsafeWindow as any).location.href = (
            nestedPage as HTMLIFrameElement
          ).src
        }
      }, 1000)

      // hide the loading gif
      addStyle(css`.web-player-loading { opacity: 0; }`)

      // make sure the player is ready
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (
            (unsafeWindow as any).livePlayer &&
            (unsafeWindow as any).livePlayer.getPlayerInfo &&
            (unsafeWindow as any).livePlayer.getPlayerInfo().playurl &&
            (unsafeWindow as any).livePlayer.switchQuality
          ) {
            clearInterval(timer)
            resolve()
          }
        }, 1000)
      })

      const livePlayer = (unsafeWindow as any).livePlayer

      // get initial pathname of video source and number of highest quality
      const initialPathname = new URL(
        livePlayer.getPlayerInfo().playurl,
      ).pathname
      const highestQualityNumber =
        livePlayer.getPlayerInfo().qualityCandidates[0].qn

      // switch quality
      setInterval(() => {
        const currentPathname = new URL(
          livePlayer.getPlayerInfo().playurl,
        ).pathname
        const currentQualityNumber =
          livePlayer.getPlayerInfo().quality
        if (
          currentPathname === initialPathname ||
          currentQualityNumber !== highestQualityNumber
        ) {
          livePlayer.switchQuality(highestQualityNumber)
        }
      }, 1000)
    })()
  },
}

export default enhanceLive
