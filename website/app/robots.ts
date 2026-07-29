import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://billiardbuddy.zzyppz.cn/sitemap.xml",
    host: "https://billiardbuddy.zzyppz.cn",
  };
}
