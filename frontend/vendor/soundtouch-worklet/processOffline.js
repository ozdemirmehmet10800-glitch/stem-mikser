/*
 * SoundTouch JS audio processing library
 * Copyright (c) Steve 'Cutter' Blades
 *
 * Licensed under the Mozilla Public License, v. 2.0.
 * You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { SoundTouchNode } from './SoundTouchNode.js';
/**
 * Renders audio through SoundTouch processing in an `OfflineAudioContext`.
 *
 * @remarks
 * Creates an `OfflineAudioContext`, registers the processor module, builds the
 * audio graph, applies all transform parameters, and returns the rendered
 * `AudioBuffer`. The output length is estimated as
 * `ceil(input.length / playbackRate)` to account for tempo changes.
 *
 * @param options Processing options including the input buffer and processor URL.
 * @returns A Promise that resolves to the processed `AudioBuffer`.
 *
 * @example
 * ```ts
 * import { processOffline } from '@soundtouchjs/audio-worklet';
 *
 * const processed = await processOffline({
 *   input: audioBuffer,
 *   processorUrl: '/soundtouch-processor.js',
 *   pitchSemitones: -3,
 *   playbackRate: 1.2,
 * });
 * ```
 */
export async function processOffline(options) {
    const { input, processorUrl, pitch = 1.0, pitchSemitones = 0, playbackRate = 1.0, interpolationStrategy, stretchParameters, sampleBufferType, } = options;
    const outputLength = Math.ceil(input.length / playbackRate);
    const offlineCtx = new OfflineAudioContext(input.numberOfChannels, outputLength, input.sampleRate);
    await SoundTouchNode.register(offlineCtx, processorUrl);
    const stNode = new SoundTouchNode({
        context: offlineCtx,
        interpolationStrategy,
        sampleBufferType,
    });
    stNode.pitch.value = pitch;
    stNode.pitchSemitones.value = pitchSemitones;
    stNode.playbackRate.value = playbackRate;
    if (stretchParameters) {
        stNode.setStretchParameters(stretchParameters);
    }
    stNode.connect(offlineCtx.destination);
    const source = offlineCtx.createBufferSource();
    source.buffer = input;
    source.playbackRate.value = playbackRate;
    source.connect(stNode);
    source.start(0);
    return offlineCtx.startRendering();
}
//# sourceMappingURL=processOffline.js.map