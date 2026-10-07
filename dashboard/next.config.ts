import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-mode badge sits on top of the terminal's bottom-left
  // panel; build/runtime errors still surface in the overlay.
  devIndicators: false,
};

export default nextConfig;
