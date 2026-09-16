// The LAN address the customer-facing QR code points at.
import os from "os";

export function registerNetworkRoutes(app) {
  // Get local IP address
  app.get("/api/local-ip", (req, res) => {
    try {
      const interfaces = os.networkInterfaces();
      let ips = [];

      // Collect all non-internal IPv4 addresses with interface names
      for (const name of Object.keys(interfaces)) {
        const networkInterface = interfaces[name];
        if (networkInterface) {
          for (const interfaceInfo of networkInterface) {
            if (interfaceInfo.family === "IPv4" && !interfaceInfo.internal) {
              ips.push({
                address: interfaceInfo.address,
                interface: name,
                isWifi:
                  name.toLowerCase().includes("wi-fi") ||
                  name.toLowerCase().includes("wlan"),
                isEthernet:
                  name.toLowerCase().includes("ethernet") ||
                  name.toLowerCase().includes("eth"),
              });
            }
          }
        }
      }

      let selectedIP = null;

      // Priority 1: Prefer IPs with common gateway patterns (.1.90, .1.100, .0.1, .1.1)
      const commonPatterns = [".1.90", ".1.100", ".0.1", ".1.1"];
      for (const pattern of commonPatterns) {
        const patternIP = ips.find((ip) => ip.address.endsWith(pattern));
        if (patternIP) {
          selectedIP = patternIP.address;
          break;
        }
      }

      // Priority 2: Look for WiFi interfaces (most common for mobile access)
      if (!selectedIP) {
        const wifiIP = ips.find(
          (ip) => ip.isWifi && ip.address.startsWith("192.168."),
        );
        if (wifiIP) {
          selectedIP = wifiIP.address;
        }
      }

      // Priority 3: Look for Ethernet interfaces
      if (!selectedIP) {
        const ethernetIP = ips.find(
          (ip) => ip.isEthernet && ip.address.startsWith("192.168."),
        );
        if (ethernetIP) {
          selectedIP = ethernetIP.address;
        }
      }

      // Priority 4: Any 192.168.x.x address
      if (!selectedIP) {
        const lanIP = ips.find((ip) => ip.address.startsWith("192.168."));
        if (lanIP) {
          selectedIP = lanIP.address;
        }
      }

      // Priority 5: Any non-internal IP
      if (!selectedIP && ips.length > 0) {
        selectedIP = ips[0].address;
      }

      // Fallback to localhost
      if (!selectedIP) {
        selectedIP = "localhost";
      }

      console.log("🌐 Local IP detected");
      res.status(200).json({ ip: selectedIP });
    } catch (err) {
      console.error("❌ Error getting local IP:", err);
      res.status(500).json({ error: "Failed to get local IP" });
    }
  });
}
