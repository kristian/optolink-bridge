import { pipeline } from 'node:stream/promises';
import { PassThrough, Transform } from 'node:stream';
import { SerialPort } from 'serialport';
import { EventEmitter } from 'node:events';

export const fromVitoToOpto = 0b01; // Vitoconnect → Optolink
export const fromOptoToVito = 0b10; // Optolink → Vitoconnect

/**
 * Connects to both the Vitoconnect and Optolink serials ports and establishes a bridge
 * between them. All 'chunk's crossing the bridge are emitted via the `EventEmitter` returned.
 * 
 * @param {string} [vitoPath = '/dev/ttyS0'] The serial port to connect to Vitoconnect.
 * @param {string} [optoPath = '/dev/ttyUSB'] The serial port to connect to Optolink.
 * @param {function} [transform] Whether to use `PassThrough` streams to directly
 *   connect both serial ports, or use a `Transform` stream to also intercept the data.
 * @returns {EventEmitter} An `EventEmitter` emitting 'chunk's.
 */
export async function connect(vitoPath = '/dev/ttyS0', optoPath = '/dev/ttyUSB0', transform) {
  const eventEmitter = new EventEmitter();
  function createBridgeStream(direction, vitoPort, optoPort) {
    const emit = (chunk, callback) => {
      try {  
        eventEmitter.emit('chunk', chunk, direction);
      } finally {
        callback?.(null, chunk);
      }
    };

    if (typeof transform !== 'function') {
      const stream = new PassThrough();
      stream.on('data', emit);
      return stream;
    } else {
      return new Transform({
        transform(chunk, encoding, callback) {
          try {
            transform.call(this, chunk, direction, /* emitCallback */ newChunk => emit(newChunk ?? chunk, callback), {
              vitoPort, optoPort, callback // note that the context object exposed the original callback as well, which is different to the emitCallback!
            });
          } catch (err) {
            // uncaught exception, always continue emitting!
            emit(chunk, callback);
            throw err;
          }
        }
      });
    }
  }
  
  const portOptions = {
    baudRate: 4800,
    parity: 'even',
    stopBits: 2,
    dataBits: 8,
    lock: true // exclusive
  };
  
  const vitoPort = new SerialPort({
    path: vitoPath,
    ...portOptions
  });
  const optoPort = new SerialPort({
    path: optoPath,
    ...portOptions
  });
  
  vitoPort.on('error', (...args) => eventEmitter.emit('error', ...args, fromVitoToOpto));
  optoPort.on('error', (...args) => eventEmitter.emit('error', ...args, fromOptoToVito));

  eventEmitter.close = async function() {
    return Promise.all([
      new Promise((resolve, reject) => vitoPort.close(err => {
        err ? reject(err) : resolve();
      })),
      new Promise((resolve, reject) => optoPort.close(err => {
        err ? reject(err) : resolve();
      }))
    ]);
  };

  eventEmitter.pipeline = Promise.all([
    pipeline(vitoPort, createBridgeStream(fromVitoToOpto, vitoPort, optoPort), optoPort),
    pipeline(optoPort, createBridgeStream(fromOptoToVito, vitoPort, optoPort), vitoPort)
  ]);

  return eventEmitter;
}
