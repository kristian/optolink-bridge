import { Buffer } from 'node:buffer';
import { Parser } from 'binary-parser-encoder-bump';

function crc256(data, crc = 0) {
  for (const byte of data) {
    crc += byte;
    crc %= 0x100;
  }
  return crc;
}

function when({ tag, type }) {
  return {
    tag: function() {
      return tag.apply(this) ? 1 : 0;
    },
    defaultChoice: new Parser(), // nothing
    choices: {
      1: type
    }
  }
}

function assertFunction(text, fn) {
  const textFunction = function() {
    return fn.apply(this, arguments);
  };
  textFunction.toString = () => text;
  return textFunction;
}

/**
 * @returns a function that can be used for readUntil, to only peek a single byte (if any)
 */
function peek() {
  return function() {
    if (!this.peeked) {
      this.peeked = true;
      return false;
    } else {
      delete this.peeked;
      return true;
    }
  };
}

const parser = new Parser()
  .useContextVars()
  .uint8('start')
  .choice({
    tag: 'start',
    choices: {
      0x04: new Parser(), // EOT (end of transmission / sync. start)
      0x16: new Parser() // SYN (synchronous idle / start of transmission)
        .uint16('zero', {
          assert: assertFunction('not matching the expected 16 00 00 start sequence', function(zero) {
            return !zero; // has to start with 16 00 00 (zero!)
          })
        }),
      0x41: new Parser() // VS2_DAP_STANDARD (packet start)
        .uint8('len')
        .saveOffset('crc')
        .pointer('raw', {
          offset: 'crc',
          type: new Parser()
            .buffer('hoist', { length: '$parent.len' }),
          formatter: struct => struct.hoist
        })
        .bit4('unused')
        .bit4('id')
        .choice({
          tag: 'id',
          choices: {
            0x0: new Parser(), // REQ
            0x1: new Parser(), // RESP
            0x2: new Parser(), // UNACK
            0x3: new Parser() // ERRMSG
          }
        })
        .bit3('seq')
        .bit5('fn')
        .choice({
          tag: 'fn',
          choices: {
            0x01: new Parser(), // Virtual_READ
            0x02: new Parser(), // Virtual_WRITE
            0x07: new Parser() // Remote_Procedure_Call
          }
        })
        .uint16be('addr') // addresses are specified in big-endian, while values are little-endian
        .uint8('dlen') // data length
        .choice(when({
          tag: function() {
            // when reading (fn = 0x01) grab data from the response (id = 0x1), when writing (fn = 0x02) from the request (id = 0x0),
            // for rpcs (fn = 0x07) it is function input & output (so both req / res have data), for errors (0x3) the data is err. msg
            return (this.fn === 0x01 && this.id === 0x1) || (this.fn === 0x02 && this.id === 0x0) || (this.fn === 0x07) || (this.id === 0x3);
          },
          type: new Parser()
            .buffer('data', { length: 'dlen' })
        }))
        .uint8('crc', {
          type: 'uint8',
          assert: assertFunction('a mismatch to the calculated CRC', function(crc) {
            // if raw is not set / empty, we are in the encoding case, CRC will be calculated in the encode function
            return !this.raw?.length || crc256(this.raw, this.len) === crc;
          })
        })
        .buffer('rest', {
          readUntil: 'eof'
        })
    }
  });

const responseParser = new Parser()
  .useContextVars()
  .uint8('res')
  .choice({
    tag: 'res',
    choices: {
      0x05: new Parser(), // ENQ (enquiry / sync. end)
      0x06: new Parser() // ACK
        .saveOffset('peek')
        .pointer('peek', { // corner case: during the handshake, single ACK (0x06) without any data, so peek for one byte
          offset: 'peek',
          type: new Parser()
            .buffer('hoist', {
              readUntil: peek(),
              encoder: function() {
                return Buffer.from(this.start ? [0xFF] : []);
              }
            }),
          formatter: struct => struct.hoist
        })
        .choice({
          tag: 'peek.length',
          defaultChoice: parser,
          choices: {
            0: new Parser()
          }
        }),
      0x15: new Parser() // NACK
    }
  });

/**
 * Parse the VS2 / 300 Optolink protocol packet.
 * 
 * @param {Buffer} data the data of the packet to parse
 * @param {boolean} [response] true in case it was a response (Optolink -> Vitoconnect) packet
 * @returns {object} the parsed data packet
 */
export function parsePacket(data, response) {
  return (response ? responseParser : parser).parse(data);
}

// make parsing the default
export default parsePacket;

const emptyBuffer = Buffer.allocUnsafe(0);
export function encodePacket(packet, response) {
  const data = (response ? responseParser : parser).encode(Object.assign({}, packet, {
    peek: 'start' in packet || 'zero' in packet ? Buffer.from([0xFF]) : emptyBuffer,
    unused: packet.unused ?? 0,
    len: packet.len ?? ((packet.data ? packet.data.length : 0) + /* 1/2 unused, 1/2 id, 3/8 seq, 5/8 fn, 2x addr, dlen */ 5),
    dlen: packet.dlen ?? (packet.data ? packet.data.length : 0),
    raw: emptyBuffer,
    rest: emptyBuffer,
    crc: 0
  }));
  
  return packet.start === 0x41 ? Buffer.concat([data.subarray(0, data.length - 1), Buffer.from([
    crc256(data.subarray(/* start byte */ 1 + (response ? /* res byte */ 1 : 0), data.length - /* crc byte */ 1))
  ])]) : data;
}

/**
 * All types supported by binary-parser
 */
export const types = Object.fromEntries([
  'uint8', 'int8',
  ...['u', ''].flatMap(prefix => [
    ...[16, 32, 64].flatMap(size => [
      `${prefix}int${size}`, `${prefix}int${size}le`, `${prefix}int${size}be`
    ])
  ]),
  ...['float', 'double'].flatMap(type => [
    `${type}le`, `${type}be`
  ]),
  ...Array.from({ length: 32 }, (value, length) => `bit${length + 1}`),
  'string', 'buffer'
].map(type => [type, undefined]));

const valueParser = new Parser()
  .uint8('type')
  .choice({
    tag: 'type',
    choices: Object.fromEntries(Object.keys(types).map((type, index) => [
      index, (() => {
        const parser = new Parser().endianess('little');

        let options;
        if (type === 'string') {
          options = { greedy: true, formatter: str => str.replace(/\x00/g, '') };
        } else if (type === 'buffer') {
          options = { readUntil: 'eof' };
        }

        parser[type].call(parser, 'value', options);
        types[type] = parser.sizeOf(); // length of the data type / dlen
        return parser;
      })()]))
  });

/**
 * Parses the given value of the specified type.
 * 
 * @param {string} [type] the type to parse, one of `types` / all supported types of binary-parser, or 'debug' for all possible types
 * @param {Buffer} data the data to parse for the given type
 * @returns {(any|object)} the parsed value, or in case no type was given, an object of all possible types matching the types length (fuzzy, types that are one byte short [e.g. int8 + status byte] will also match, ignoring the last byte of data)
 */
export function parseValue(type, data) {
  if (type === 'debug' || typeof type !== 'string' && (data = type)) {
    // debug mode: return all possible types fitting for the given data length
    return Object.fromEntries(Object.entries(types).filter(([type, length]) =>
        length === data.length || length === data.length - 1 || type === 'buffer' || type === 'string')
      .map(([type]) => [type, parseValue(type, data)]));
  } else if (type === 'raw' || type === 'byte') { // aliases for buffer
    type = 'buffer';
  } else if (type === 'utf8') { // alias for string
    type = 'string';
  } else if (type === 'int' || type === 'uint') {
    let length = data.length;
    if (length <= 0) {
      throw new Error(`Minimum length for (u)int types is 1, got ${length}`)
    } else if (length > 2 && (length % 2) !== 0) {
      length--; // remove status bit, 3 -> 2, 5 -> 4, 9 -> 8
    }

    if ((length & (length - 1)) !== 0) { // must be power of 2: 1, 2, 4, 8
      throw new Error(`Length of (u)int types must be power of 2 (1 / 2 / 4 / 8), got ${length}`)
    } else if (length > 8) {
      throw new Error(`Maximum length for (u)int types is 8, got ${length}`);
    }

    type = `${type}${length * 8}`;
  }

  const index = Object.keys(types).indexOf(type);
  if (index === -1) {
    throw new Error(`Unknown data type ${type}`);
  }

  return valueParser.parse(Buffer.from([Object.keys(types).indexOf(type), ...data])).value;
}
