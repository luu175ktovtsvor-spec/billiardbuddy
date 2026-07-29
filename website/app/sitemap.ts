import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://billiardbuddy.zzyppz.cn",
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
