import { noop } from 'foxts/noop';
import type { Noop } from 'foxts/noop';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';

const neverResolvedPromise = new Promise(noop);
const noopNeverResolvedPromise = () => neverResolvedPromise;

// based on uBlock Origin's no-webrtc
// https://github.com/gorhill/uBlock/blob/6c228a8bfdcfc14140cdd3967270df28598c1aaf/src/js/resources/scriptlets.js#L2216
const noWebRTC: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'no-webrtc',
  description: '通过禁用 WebRTC 防止叔叔省下棺材钱',
  any() {
    const rtcPcNames: string[] = [];

    if ('RTCPeerConnection' in unsafeWindow) {
      rtcPcNames.push('RTCPeerConnection');
    }
    if ('webkitRTCPeerConnection' in unsafeWindow) {
      rtcPcNames.push('webkitRTCPeerConnection');
    }
    if ('mozRTCPeerConnection' in unsafeWindow) {
      rtcPcNames.push('mozRTCPeerConnection');
    }

    const rtcDcNames: string[] = [];

    if ('RTCDataChannel' in unsafeWindow) {
      rtcDcNames.push('RTCDataChannel');
    }
    if ('webkitRTCDataChannel' in unsafeWindow) {
      rtcDcNames.push('webkitRTCDataChannel');
    }
    if ('mozRTCDataChannel' in unsafeWindow) {
      rtcDcNames.push('mozRTCDataChannel');
    }

    class MockDataChannel implements Pick<RTCDataChannel, 'close' | 'send' | 'addEventListener' | 'removeEventListener' | 'onbufferedamountlow' | 'onclose' | 'onerror' | 'onmessage' | 'onopen'> {
      declare close: Noop;
      declare send: Noop;
      declare addEventListener: Noop;
      declare removeEventListener: Noop;

      declare onbufferedamountlow: Noop;
      declare onclose: Noop;
      declare onerror: Noop;
      declare onmessage: Noop;
      declare onopen: Noop;

      static {
        this.prototype.close = noop;
        this.prototype.send = noop;
        this.prototype.addEventListener = noop;
        this.prototype.removeEventListener = noop;
        this.prototype.onbufferedamountlow = noop;
        // eslint-disable-next-line sukka/unicorn/prefer-add-event-listener -- mock
        this.prototype.onclose = noop;
        // eslint-disable-next-line sukka/unicorn/prefer-add-event-listener -- mock
        this.prototype.onerror = noop;
        // eslint-disable-next-line sukka/unicorn/prefer-add-event-listener -- mock
        this.prototype.onmessage = noop;
      }

      toString() {
        return '[object RTCDataChannel]';
      }
    }

    class MockRTCSessionDescription implements RTCSessionDescription {
      readonly type: RTCSdpType;
      readonly sdp: string;

      constructor(init: RTCSessionDescriptionInit) {
        this.type = init.type;
        this.sdp = init.sdp || '';
      }

      toJSON(): RTCSessionDescriptionInit {
        return {
          type: this.type,
          sdp: this.sdp
        };
      }

      toString() {
        return '[object RTCSessionDescription]';
      }
    }

    const mockedRtcSessionDescription = new MockRTCSessionDescription({
      type: 'offer',
      sdp: ''
    });

    class MockRTCPeerConnection implements Pick<RTCPeerConnection, 'close' | 'createDataChannel' | 'createOffer' | 'setRemoteDescription' | 'addEventListener' | 'removeEventListener' | 'addIceCandidate' | 'setLocalDescription' | 'setConfiguration' | 'localDescription' | 'createAnswer' | 'onicecandidate'> {
      createDataChannel() {
        return new MockDataChannel() as RTCDataChannel;
      }

      declare close: Noop;
      declare createOffer: Noop;
      declare setLocalDescription: Noop;
      declare setRemoteDescription: Noop;
      declare addEventListener: Noop;
      declare removeEventListener: Noop;
      declare addIceCandidate: Noop;

      declare setConfiguration: Noop;

      declare localDescription: RTCSessionDescription;

      declare createAnswer: Noop;

      declare onicecandidate: Noop;

      static {
        this.prototype.close = noop;
        this.prototype.createOffer = noopNeverResolvedPromise;
        this.prototype.setLocalDescription = noop;
        this.prototype.setRemoteDescription = noop;
        this.prototype.addEventListener = noop;
        this.prototype.removeEventListener = noop;
        this.prototype.addIceCandidate = noop;

        this.prototype.setConfiguration = noop;
        this.prototype.localDescription = mockedRtcSessionDescription;

        this.prototype.createAnswer = noopNeverResolvedPromise;
        this.prototype.onicecandidate = noop;
      }

      toString() {
        return '[object RTCPeerConnection]';
      }
    }

    for (const rtc of rtcPcNames) {
      defineReadonlyProperty(unsafeWindow, rtc, MockRTCPeerConnection);
    }

    for (const dc of rtcDcNames) {
      defineReadonlyProperty(unsafeWindow, dc, MockDataChannel);
    }

    defineReadonlyProperty(unsafeWindow, 'RTCSessionDescription', MockRTCSessionDescription);
  }
};

export default noWebRTC;
