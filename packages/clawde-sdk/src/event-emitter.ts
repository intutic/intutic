import { EventEmitter } from 'events'
import { EventCallback } from './types'

export class ClawdeEventEmitter {
  private emitter = new EventEmitter()

  public on(event: 'hijack' | 'enhance' | 'kill' | 'bypass', callback: EventCallback): void {
    this.emitter.on(event, callback)
  }

  public off(event: string, callback: EventCallback): void {
    this.emitter.off(event, callback)
  }

  public emit(event: string, data: any): void {
    this.emitter.emit(event, data)
  }
}
