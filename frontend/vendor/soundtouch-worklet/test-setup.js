import { vi } from 'vitest';
class MockAudioWorkletNode {
    parameters = new Map();
    constructor(_context, _name, _options) { }
}
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
//# sourceMappingURL=test-setup.js.map