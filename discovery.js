import packageJson from './package.json' with { type: 'json' };
import { capitalCase } from 'change-case';

export async function publishDevice({
  mqttClient, mqttAvailabilityTopic, mqttDpTopic,
  deviceSerialNo, prefix = 'homeassistant', dps, overrides = {}
}) {
  if (!deviceSerialNo) {
    throw new TypeError('Device serial number must be provided');
  }

  function discoveryComponent(dp) {
    const unique_id = `vito_${deviceSerialNo}_${dp.name}`;

    // check if there are any overrides for this data point
    let platform = 'sensor', override;
    for (const overridePlatform of Object.keys(overrides)) {
      if (overridePlatform === 'device') { continue; }
      if (override = overrides[overridePlatform]?.[dp.name]) {
        platform = overridePlatform; // the override determines the platform of the data point
        break;
      }
    }

    if (override === false) {
      return {}; // do not include this data point in device discovery
    } else if (override === true) {
      override = {}; // include this data point with default settings in the specified platform
    }

    return {
      [unique_id]: {
        platform,

        unique_id,
        name: capitalCase(dp.name), // will automatically get prefixed with the device name
        state_topic: mqttDpTopic(dp),

        ...(override ?? {})
      }
    };
  }

  // build the discovery record
  const discoveryPayload = {
    device: {
      identifiers: deviceSerialNo,
      serial_number: deviceSerialNo,
      name: 'Vito', model: `Vito`,
      manufacturer: 'Viessmann',
      ...(overrides?.device ?? {})
    },
    origin: { // see https://www.home-assistant.io/integrations/mqtt/#adding-information-about-the-origin-of-a-discovery-message
      name: 'optolink-bridge',
      sw_version: packageJson.version,
      support_url: 'https://github.com/kristian/optolink-bridge/issues'
    },
    ...(mqttAvailabilityTopic ? {
      availability: [ // see https://www.home-assistant.io/integrations/mqtt/#using-availability-topics
        {
          topic: mqttAvailabilityTopic,
          payload_available: 'true',
          payload_not_available: 'false',
        }
      ]
    } : {}),
    components: Object.assign({}, ...[...(dps?.values() ?? [])].map(discoveryComponent))
  };

  // publish to device discovery topic, see: https://www.home-assistant.io/integrations/mqtt/#discovery-messages
  // config messages are retained, see: https://www.home-assistant.io/integrations/mqtt/#using-retained-config-messages
  await mqttClient.publishAsync(`${prefix ?? 'homeassistant'}/device/vito_${deviceSerialNo}/config`,
    JSON.stringify(discoveryPayload), { retain: true });
}
