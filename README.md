# luci-app-mobilenetwork

LuCI application for mobile network management on GL.iNet OpenWrt routers.

## Features

- Mobile network connection status monitoring
- Signal strength display (RSRP, RSRQ, SINR, RSSI)
- APN configuration management
- Data usage tracking
- Network mode selection (2G/3G/4G/5G)

## Installation

1. SSH into your GL.iNet router
2. Install the package:
   ```bash
   opkg update
   opkg install luci-app-mobilenetwork
   ```
3. Access via LuCI web UI: **Network → Mobile Network**

## Supported Devices

- GL.iNet routers with built-in cellular modems
- Quectel EC25, RM500Q, RM520N, and compatible modules

## Contributing

Issues and pull requests are welcome!
