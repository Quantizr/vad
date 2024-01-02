"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioNodeVAD = exports.MicVAD = exports.defaultRealTimeVADOptions = void 0;
const ort = __importStar(require("onnxruntime-web"));
const soundbank_pitch_shift_1 = require("soundbank-pitch-shift");
const _common_1 = require("./_common");
const asset_path_1 = require("./asset-path");
const default_model_fetcher_1 = require("./default-model-fetcher");
exports.defaultRealTimeVADOptions = {
    ..._common_1.defaultFrameProcessorOptions,
    onFrameProcessed: (probabilities) => { },
    onVADMisfire: () => {
        _common_1.log.debug("VAD misfire");
    },
    onSpeechStart: () => {
        _common_1.log.debug("Detected speech start");
    },
    onSpeechEnd: () => {
        _common_1.log.debug("Detected speech end");
    },
    workletURL: (0, asset_path_1.assetPath)("vad.worklet.bundle.min.js"),
    modelURL: (0, asset_path_1.assetPath)("silero_vad.onnx"),
    modelFetcher: default_model_fetcher_1.defaultModelFetcher,
    stream: undefined,
};
class MicVAD {
    static async new(options = {}) {
        const fullOptions = {
            ...exports.defaultRealTimeVADOptions,
            ...options,
        };
        (0, _common_1.validateOptions)(fullOptions);
        let stream;
        if (fullOptions.stream === undefined)
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    ...fullOptions.additionalAudioConstraints,
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                },
            });
        else
            stream = fullOptions.stream;
        const audioContext = new AudioContext();
        const sourceNode = new MediaStreamAudioSourceNode(audioContext, {
            mediaStream: stream,
        });
        const audioNodeVAD = await AudioNodeVAD.new(audioContext, fullOptions);
        audioNodeVAD.receive(sourceNode);
        return new MicVAD(fullOptions, audioContext, stream, audioNodeVAD, sourceNode);
    }
    constructor(options, audioContext, stream, audioNodeVAD, sourceNode, listening = false) {
        this.options = options;
        this.audioContext = audioContext;
        this.stream = stream;
        this.audioNodeVAD = audioNodeVAD;
        this.sourceNode = sourceNode;
        this.listening = listening;
        this.pause = () => {
            this.audioNodeVAD.pause();
            this.listening = false;
        };
        this.start = () => {
            this.audioNodeVAD.start();
            this.listening = true;
        };
        this.destroy = () => {
            if (this.listening) {
                this.pause();
            }
            if (this.options.stream === undefined) {
                this.stream.getTracks().forEach((track) => track.stop());
            }
            this.sourceNode.disconnect();
            this.audioNodeVAD.destroy();
            this.audioContext.close();
        };
    }
}
exports.MicVAD = MicVAD;
class AudioNodeVAD {
    static async new(ctx, options = {}) {
        const fullOptions = {
            ...exports.defaultRealTimeVADOptions,
            ...options,
        };
        (0, _common_1.validateOptions)(fullOptions);
        await ctx.audioWorklet.addModule(fullOptions.workletURL);
        const vadNode = new AudioWorkletNode(ctx, "vad-helper-worklet", {
            processorOptions: {
                frameSamples: fullOptions.frameSamples,
            },
            parameterData: {
                audioSpeed: 1,
            },
        });
        const model = await _common_1.Silero.new(ort, () => fullOptions.modelFetcher(fullOptions.modelURL));
        const frameProcessor = new _common_1.FrameProcessor(model.process, model.reset_state, {
            frameSamples: fullOptions.frameSamples,
            positiveSpeechThreshold: fullOptions.positiveSpeechThreshold,
            negativeSpeechThreshold: fullOptions.negativeSpeechThreshold,
            redemptionFrames: fullOptions.redemptionFrames,
            preSpeechPadFrames: fullOptions.preSpeechPadFrames,
            minSpeechFrames: fullOptions.minSpeechFrames,
            submitUserSpeechOnPause: fullOptions.submitUserSpeechOnPause,
        });
        const pitchShift = (0, soundbank_pitch_shift_1.PitchShift)(ctx);
        const audioNodeVAD = new AudioNodeVAD(ctx, fullOptions, frameProcessor, vadNode, pitchShift);
        vadNode.port.onmessage = async (ev) => {
            switch (ev.data?.message) {
                case _common_1.Message.AudioFrame:
                    const buffer = ev.data.data;
                    const frame = new Float32Array(buffer);
                    await audioNodeVAD.processFrame(frame);
                    break;
                default:
                    break;
            }
        };
        return audioNodeVAD;
    }
    constructor(ctx, options, frameProcessor, entryNode, pitchShift) {
        this.ctx = ctx;
        this.options = options;
        this.frameProcessor = frameProcessor;
        this.entryNode = entryNode;
        this.pitchShift = pitchShift;
        this.pause = () => {
            const ev = this.frameProcessor.pause();
            this.handleFrameProcessorEvent(ev);
        };
        this.start = () => {
            this.frameProcessor.resume();
        };
        this.receive = (node) => {
            node.connect(this.pitchShift);
            this.pitchShift.connect(this.entryNode);
        };
        this.updateAudioSpeed = (speed) => {
            let cappedSpeed = Math.min(speed, 2);
            this.entryNode.parameters.get('audioSpeed')?.setValueAtTime(cappedSpeed, this.ctx.currentTime);
            this.pitchShift.transpose = 12 * Math.log2(cappedSpeed);
            console.log("Changed audioSpeed real-time-vad.ts: ", this.entryNode.parameters.get('audioSpeed'));
        };
        this.processFrame = async (frame) => {
            const ev = await this.frameProcessor.process(frame);
            this.handleFrameProcessorEvent(ev);
        };
        this.handleFrameProcessorEvent = (ev) => {
            if (ev.probs !== undefined) {
                this.options.onFrameProcessed(ev.probs);
            }
            switch (ev.msg) {
                case _common_1.Message.SpeechStart:
                    this.options.onSpeechStart();
                    break;
                case _common_1.Message.VADMisfire:
                    this.options.onVADMisfire();
                    break;
                case _common_1.Message.SpeechEnd:
                    this.options.onSpeechEnd(ev.audio);
                    break;
                default:
                    break;
            }
        };
        this.destroy = () => {
            this.entryNode.port.postMessage({
                message: _common_1.Message.SpeechStop,
            });
            this.entryNode.disconnect();
        };
    }
}
exports.AudioNodeVAD = AudioNodeVAD;
//# sourceMappingURL=real-time-vad.js.map