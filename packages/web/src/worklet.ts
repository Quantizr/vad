import { Message, log, Resampler } from "./_common"

interface WorkletOptions {
  frameSamples: number
}

class Processor extends AudioWorkletProcessor {
  // @ts-ignore
  resampler: Resampler
  _initialized = false
  _stopProcessing = false
  options: WorkletOptions
  targetRatio: number

  static get parameterDescriptors() {
    return [{name: 'audioSpeed', defaultValue: 1}];
  }

  constructor(options) {
    super()
    this.options = options.processorOptions as WorkletOptions
    this.targetRatio = 1

    this.port.onmessage = (ev) => {
      if (ev.data.message === Message.SpeechStop) {
        this._stopProcessing = true
      }
    }

    this.init()
  }
  init = async () => {
    log.debug("initializing worklet")
    this.resampler = new Resampler({
      nativeSampleRate: sampleRate,
      targetSampleRate: 16000,
      targetFrameSize: this.options.frameSamples,
      targetSpeed: 1,
    })
    this._initialized = true
    log.debug("initialized worklet")
  }
  updateAudioSpeed = (speed: number) => {
    //this.targetRatio = Math.min(speed, sampleRate/16000)
    this.resampler.options.targetSampleRate = Math.floor(16000*speed)//this.targetRatio)
  }
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    if (this._stopProcessing) {
      return false
    }
    this.updateAudioSpeed(parameters["audioSpeed"][0])
    // @ts-ignore
    const arr = inputs[0][0]

    if (this._initialized && arr instanceof Float32Array) {
      const frames = this.resampler.process(arr)
      for (const frame of frames) {
        this.port.postMessage(
          { message: Message.AudioFrame, data: frame.buffer },
          [frame.buffer]
        )
      }
    }

    return true
  }
}

registerProcessor("vad-helper-worklet", Processor)
