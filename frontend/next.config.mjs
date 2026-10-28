/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["postgres", "bcryptjs", "jsonwebtoken", "otplib", "fernet", "@anthropic-ai/sdk"],
  },
};

export default nextConfig;
