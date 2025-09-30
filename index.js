import async from 'async';
import { readConfig, mapDataPoints, dateTimeString, formatAddr, directionName, fromLocalToOpto, fromOptoToLocal, toOpto, fromOpto } from './utils.js';
import { toFormat as bufferToFormat } from 'buffer-to-str';
import Queue from 'yocto-queue';

import { connectAsync as mqttConnect } from 'mqtt';

import { connect, fromOptoToVito, fromVitoToOpto } from './serial.js';
import { default as parsePacket, encodePacket } from './parse_vs2.js';

let logLevel, trace, logger = {}, dps, pollQueue = new Queue(), pollIntervals, busState = 0; // 0: syncing, 1: synced, 2: flowing

function applyConfig(config) {
  logLevel = {
    debug: 4, // debug log of all unknown data points
    info: 3, // logs all known data points
    warn: 2,
    error: 1,
    none: 0
  }[config.log_level ?? 'warn'] || 2; // default to warn
  trace = config.log_level === 'trace'; // trace all serial communication
  Object.assign(logger, {
    debug: logLevel >= 4 ? console.debug : () => {},
    info: logLevel >= 3 ? console.log : () => {},
    warn: logLevel >= 2 ? console.warn : () => {},
    error: logLevel >= 1 ? console.error : () => {},
  });
  
  if (!dps || (config.auto_reload_addr_items ?? true)) {
    dps ??= new Map();

    // clear all existing poll intervals
    for (const pollInterval of (pollIntervals ?? [])) {
      clearInterval(pollInterval);
    }
    pollIntervals = [];

    // convert the data points to a structured array
    mapDataPoints(config.data_points, (dps.clear(), dps));

    // create poll intervals for each poll item
    let pollsPerSecond = 0.;
    for (const [ival, addr, dlen] of (config.poll_items ?? [])) {
      if (ival <= 0) {
        logger.error(`Poll interval for address ${formatAddr(addr)} is less than zero, skipping poll request`);
        continue;
      }

      const pollItem = (dupWarning = true) => {
        // check if the address is already in the poll queue
        for (const { addr: qaddr } of pollQueue) {
          if (qaddr === addr) {
            dupWarning && logger.warn(`Address ${formatAddr(addr)} is already in the poll queue, this could indicate that the poll queue is saturated, i.e. you are polling more items than Vitoconnect & the Optolink interface can handle (approx. 10 items by Vitoconnect and 10 poll items per second), or that polling has not yet started / is otherwise halted, resulting in the poll queue to overflow. Also check for duplicates in your poll_items list.`);
            return;
          }
        }

        pollQueue.enqueue({ addr, dlen });
      };

      pollsPerSecond += 1. / ival;
      pollIntervals.push(setInterval(pollItem, ival * 1000));
      pollItem(false /* do not print a warning if it is already in the queue (on reload) */); // poll the item once immediately after startup
    }
    pollsPerSecond > 5. && logger.warn(`You are polling more than 5 items per second, which exceeds the (theoretical) limit of the low 4,800 bps Optolink bus baud rate. Please consider reducing the number of items in your poll_items list or the polling rate of the existing items (refer to the ival comment in the config.toml file for further information) and monitor the logs for saturation warnings of the poll queue.`);
  }

  return config;
}

// read and apply the config and also use "applyConfig" when the config changes
const config = applyConfig(await readConfig(applyConfig));

let mqttClient, mqttTopic, mqttAvailabilityTopic;
if (config.mqtt && config.mqtt.url) {
  config.mqtt.online ??= true; // if not set, use a online topic
  mqttTopic = config.mqtt.topic ?? 'Vito', mqttAvailabilityTopic =
    `${mqttTopic}${mqttTopic.endsWith('/') || config.mqtt.online.startsWith?.('/') ? '' : '/'}${
      typeof config.mqtt.online === 'string' ? config.mqtt.online : 'online'}`;

  const mqttOptions = {
    username: config.mqtt.username,
    password: config.mqtt.password,
    ...(config.mqtt.options || {}),
    ...((config.mqtt.online ?? true) ? {
      will: { // last will to set topic offline
        topic: mqttAvailabilityTopic,
        payload: `${false}`,
        retain: true
      }
    } : {})
  };

  // connect to MQTT broker
  mqttClient = await mqttConnect(config.mqtt.url, mqttOptions);
  const mqttConnected = async () => {
    config.mqtt.online && await mqttClient.publishAsync(
      mqttAvailabilityTopic, `${true}`, { retain: true });
  };
  await mqttConnected(); // set online topic
  mqttClient.on('connect', mqttConnected);
} else {
  logger.warn('No MQTT (URL) configuration found, not publishing to MQTT');
}

// the packet queue handles all fully received packets from opto. or vito. side, as well as already parsed packets received from the polling intercept
const polledAddr = new Set();
const packetQueue = async.queue(async task => {
  trace && console.log(dateTimeString(), directionName(task.direction), (task.data ?? encodePacket(task.packet, task.direction & fromOpto)).toString('hex'));

  const packet = task.packet ?? parsePacket(task.data, task.direction & fromOpto);

  if (busState === 0 && task.direction & toOpto && packet.start === 0x16 && 'zero' in packet) {
    busState = 1;
  } else if (busState === 1 && task.direction & fromOpto && packet.res === 0x06 && !packet.peek?.length) {
    busState = 2;

    logger.info('Synchronization completed. Streams are now flowing');
  }

  if (task.direction & toOpto && packet.addr && !polledAddr.has(packet.addr)) {
    if (task.direction === fromVitoToOpto && (config.poll_items ?? []).some(([, addr]) => addr === packet.addr)) {
      logger.info(`Vitoconnect sent a request for address ${formatAddr(packet.addr)}. This address is also on your poll_items list. In order to not waste any bandwidth on the Optolink bus, it is generally recommended to remove this address from the poll_items list and rely on Vitoconnect polling the item instead. This info is only printed once, even though Vitoconnect might continue pulling this item.`);
    }
    polledAddr.add(packet.addr);
  }

  if (packet.id === 0x2) { // UNACK
    logger.error(`Packet unacknowledged (${formatAddr(packet.addr)})`);
    return;
  } else if (packet.id === 0x3) { // ERRMSG
    logger.error(`Packet with error message (${formatAddr(packet.addr)}):`, packet.data?.toString('hex'));
    return;
  } else if (!packet.data || !(
    // for Virtual_READ (fn = 0x01) and RPCs (fn = 0x07), grab the data from the response (id = 0x1)
    ((packet.fn === 0x01 || packet.fn === 0x07) && packet.id === 0x1) ||
    // for Virtual_WRITE (fn = 0x02), grab the data from the request (id = 0x0)
    (packet.fn === 0x02 && packet.id === 0x0)
  )) {
    // ignore any packets that are not reading / writing data
    return;
  }

  const dp = dps.get(packet.addr);
  if (!dp && !config.publish_unknown_dps) {
    logger.debug(`Unknown data point (${formatAddr(packet.addr)}):`, packet.data?.toString('hex'));
    return;
  }

  // parse the value based on the data point definition, or publish the raw data
  const value = dp ? dp.parse(packet.data) : packet.data;

  const suffix = (dp ? (config.suffix ?? '<dpname>') : (config.unknown_dp_suffix ?? 'raw/<addr>'))
    .replaceAll(/<(?:dp)?addr>/g, formatAddr(packet.addr))
    .replaceAll(/<dpname>/g, dp?.name ?? 'unknown');
  const topic = `${mqttTopic}${mqttTopic.endsWith('/') || suffix.startsWith('/') ? '' : '/'}${suffix}`;

  logger.debug(`Publishing ${dp ? dp.name : 'unknown'} data point (${formatAddr(packet.addr)}) to ${topic}:`, value);
  await mqttClient.publishAsync(topic, Buffer.isBuffer(value) ? bufferToFormat(value, config.buffer_format ?? 'hex') :
    `${ typeof value === 'number' ? parseFloat(value.toFixed(config.max_decimals ?? 4 )) : value }`);
}, 1 /* no concurrency, packets should to be processed in order */);
packetQueue.error((err, task) => {
  logger.error(`Error while processing packet: ${task?.data?.toString('hex')}`, err);
});
setTimeout(() => {
  for (const { name, addr } of (dps?.values() ?? []).filter(({ addr }) => !polledAddr.has(addr) && !(config.poll_items ?? []).some(([, pollAddr]) => pollAddr === addr))) {
    logger.info(`Even after one hour, your data point ${name} with address ${formatAddr(addr)} was never polled from Optolink. This could indicate that Vitoconnect never pulls this item proactively. Consider adding the address to your poll list, so it will be actively polled.`);
  }
}, 60 * 60 * 1000); // after 1 hour

// the chunk queue handles each single chunk received from either vito. or opto. side and emit a packet, as soon as the transmit direction changes
let direction, chunks = [];
const chunkQueue = async.queue(async task => {
  if (direction !== task.direction) {
    if (chunks.length === 1) {
      packetQueue.push({ data: chunks[0], direction });
    } else if (chunks.length > 1) {
      packetQueue.push({ data: Buffer.concat(chunks), direction });
    }

    direction = task.direction;
    chunks = [];
  }

  const { data, packet } = task;
  if (data || packet) {
    // special case: in order to keep the order of processed chunks / packets, we need to push pulled packets through the chunk queue as well
    packetQueue.push({ data, packet, direction });
  } else {
    chunks.push(task.chunk);
  }
}, 1 /* no concurrency, chunks need to be processed in order */);
chunkQueue.error((err, task) => {
  logger.error('Error while processing chunk:', err);
});

// the intercept function is only called, in case poll_items have been defined. this intercept takes care of injecting poll requests to the message flow
let nextPoll, pollCallback, pollChunks = [];
function interceptPolling(chunk, direction, emitCallback, { vitoPort, optoPort, callback }) {
  if (direction === fromOptoToVito) {
    if (!pollCallback) {
      // if we are in the response cycle (data from opto. to vito.),
      // determine if (on next request cycle), we should inject a poll request
      // attention: multiple chunks may flow in the same direction multiple times!
      !nextPoll && busState === 2 && (nextPoll = pollQueue.dequeue());
      emitCallback(); // then call the callback, so the data is actually forwarded to the vito. and the next request cycle can start
    } else {      
      // there is a poll callback, meaning the previous request was a poll request,
      // so this is our result, don't forward it and collect the chunks of the result
      pollChunks.push(chunk);
      // call the raw callback (not the emitCallback!) to continue the serial pipeline,
      // but do not pass any data back to the vito., as this is our packet!
      callback(null, Buffer.alloc(0));

      try { // continue reading until we received a valid packet
        const packet = parsePacket(Buffer.concat(pollChunks), true);
        if (packet.res === 0x06 && !packet.peek?.length) {
          return; // it is just the ACK so far, continue reading
        }

        // put the (already parsed) packet into the packet queue
        // note: we pass the packet through the chunk queue, in order to uphold the order of packets
        chunkQueue.push({ packet, direction: fromOptoToLocal });

        // continue by sending the next call from vito. to opto.
        const contCallback = pollCallback;
        nextPoll = pollCallback = undefined;
        pollChunks = []; // reset the chunks, as we have received a full packet
        contCallback();
      } catch (err) {
        // nothing to do here, assume we have not received the full packet yet
        logger.debug('Parsing polled packet failed:', err.message);
      }
    }
  } else { // vito. to opto.
    if (!nextPoll) {
      // there is nothing to poll, so callback immediately to initiate the next vito. to opto. request
      emitCallback();
    } else {
      // there is an item we should poll, so don't send the current request to optolink, but inject our request
      // instead and remember the current / next poll callback
      pollCallback = emitCallback;

      const packet = {
        start: 0x41, // VS2
        id: 0x0, // REQ
        seq: 0, // no sequence no.
        fn: 0x01, // Virtual_READ
        ...nextPoll // addr and dlen
      };

      // put the packet into the packet queue
      // note: we pass the packet through the chunk queue, in order to uphold the order of packets
      chunkQueue.push({ packet, direction: fromLocalToOpto });

      // push the chunk to the reading side of the serial connection
      optoPort.write(encodePacket(packet));
    }
  }
}

// this is the main "magic", connecting to both serial ports and handling the data flow
const serial = await connect(config.port_vito ?? '/dev/ttyS0', config.port_opto ?? '/dev/ttyUSB0',
  config.poll_items?.length && interceptPolling);
serial.on('chunk', function(chunk, direction) {
  chunkQueue.push({ chunk, direction });
});
serial.on('error', function(err, direction) {
  logger.error(`Error on serial port ${directionName(direction)}:`, err);
});

logger.info(`Started in ${config.poll_items?.length ? 'intercept' : 'pass-through'} mode, waiting for synchronization`);

// after registering for a chunk event listener, await the pipelines
await serial.pipeline;
