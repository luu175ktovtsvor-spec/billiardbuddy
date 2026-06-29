/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // 生成工作室用 react-konva(局部重绘 mask)。konva 的 node 入口会去 require 可选的 'canvas' 原生包,
  // 即便 dynamic(ssr:false),Next 服务端编译仍会静态分析到它 → "Module not found: canvas"。
  // 我们只在客户端用 konva,这里把 canvas 外部化/置空,别让服务端打包它。
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias || {}), canvas: false };
    return config;
  },
  async rewrites() {
    const proxyTarget = process.env.API_PROXY_URL || "http://localhost:8000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${proxyTarget}/api/v1/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${proxyTarget}/uploads/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
