import fs from 'fs/promises';
import { watch } from 'chokidar';
import { parse as parseToml } from 'smol-toml';
import { parseValue } from './parse_vs2.js';
import { fromOptoToVito, fromVitoToOpto } from './serial.js';

export const fromLocalToOpto = 0b0100; // Local → Optolink
export const fromOptoToLocal = 0b1000; // Optolink → Local

export const toOpto = 0b0101; // → Optolink (check with & toOpto)
export const fromOpto = 0b1010; // Optolink → (check with & fromOpto)

/**
 * Check if a file (/ directory) exists on the file system.
 *
 * @param {string} path the path to check to exist
 * @returns {boolean} true if the file exists, false otherwise
 */
export async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    } else {
      throw err;
    }
  }
}

/**
 * Read the configuration file (config.toml / local_config.toml) and parse the TOML.
 *
 * @param {function} [watchCallback] a function to call when the configuration file changes
 * @returns {object} the parsed TOML configuration
 */
export async function readConfig(watchCallback) {
  const configFile = (await exists('local_config.toml')) ?
    'local_config.toml' : 'config.toml';

  if (typeof watchCallback === 'function') {
    watch(configFile, {
      awaitWriteFinish: true,
      persistent: false, // do not keep the process running
      encoding: 'utf8'
    }).on('change', async () => {
      await watchCallback(await readConfig());
    });
  }

  return parseToml(await fs.readFile(configFile, 'utf8'));
}

/**
 * Return a date / time string in the current timezone in ISO format w/o "TZ" separators.
 *
 * @returns {string} a date time string
 */
const tzOffset = new Date().getTimezoneOffset();
export function dateTimeString(date = Date.now()) {
  return new Date((+date) - tzOffset * 60 * 1000)
    .toISOString().replaceAll(/[TZ]/g, ' ').trim();
}

/**
 * Format a address by padding it to a 4 character hex string.
 * 
 * @param {number} addr the address to format
 * @returns {string} the formatted address
 */
export function formatAddr(addr, prefix = '0x') {
  if (typeof addr !== 'number') {
    throw new TypeError(`Expected address to be a number, got ${typeof addr}`);
  }
  return `${prefix}${addr.toString(16).padStart(4, '0')}`;
}

/**
 * Format the direction of data transfer to a human-readable string.
 *
 * @param {number} direction the direction to format
 * @returns {string} the formatted direction
 */
export function directionName(direction) {
  switch (direction) {
    case fromVitoToOpto:
      return 'Vitoconnect → Optolink';
    case fromOptoToVito:
      return 'Optolink → Vitoconnect';
    case fromLocalToOpto:
      return 'Local → Optolink';
    case fromOptoToLocal:
      return 'Optolink → Local';
    default:
      return 'Unknown';
  }
}

/**
 * Create a `Map` from a given array of data points, mapping the data point address to the data point.
 * 
 * @param {Array<object>} dps the data points to create a map for
 * @param {Map} [map] the map to add the data points to
 * @returns {Map} the map of data points
 */
export function mapDataPoints(dps, map = new Map()) {
  for (const dp of (dps ?? [])) {
    let [name, addr, type, scale] = dp;

    if (typeof type === 'number') {
      const signed = !!scale;
      scale = type;
      type = 'int';
      if (!signed) {
        type = `u${type}`;
      }
    }

    if (map.has(addr)) {
      throw new TypeError(`Duplicate data point "${name}" with address ${formatAddr(addr)}`);
    }

    map.set(addr, {
      name, addr, type, scale, parse: data => {
        let value = parseValue(type, data);
        if (Number.isFinite(scale)) {
          if (typeof value === 'number') {
            value *= scale;
          } else if (typeof value === 'bigint') {
            value *= BigInt(scale);
          }
        }
      
        return value;
      }
    });
  }

  return map;
}
