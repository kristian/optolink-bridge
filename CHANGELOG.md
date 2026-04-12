# Changelog

This file documents all *major & minor* releases. For revisions, please consult the [commit history](https://github.com/kristian/optolink-bridge/commits/main).

## [1.3] - 2026-04-12

Introduce a `max_buffer_chunks` option to prevent stalled streams from filling up the memory with too many buffered chunks, and expose the vito + opto serial ports and bridges on the event emitter for debugging purposes.

## [1.2] - 2026-01-08

Introduce a `publish_bus_state` MQTT option

## [1.1] - 2025-12-17

Major dependencies bump & allow Vitoconnect to reset the synchronization

## [1.0] - 2025-02-26

Initial release
