// prisma/seed.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Partner IDs 102–106 per your seed plan
  const profiles = [
    { partnerId: 102, name: "Siargao Bay Suites", city: "General Luna", country: "PH" },
    { partnerId: 103, name: "Pacifico Breeze Villas", city: "San Isidro",     country: "PH" },
    { partnerId: 104, name: "Daku Island Retreat",   city: "General Luna",    country: "PH" },
    { partnerId: 105, name: "Magpupungko Tide Inn",  city: "Pilar",           country: "PH" },
    { partnerId: 106, name: "Naked Island Cabins",   city: "General Luna",    country: "PH" },
    { partnerId: 2,   name: "Siargao Bay Suites",    city: "General Luna",    country: "PH" },
  ];

  // Photos: use unique keys (required by your schema), include sortOrder & isCover
  const photos: Array<{
    partnerId: number;
    key: string;           // unique
    url: string;
    alt?: string;
    isCover?: boolean;
    sortOrder?: number;
  }> = [
    { partnerId: 102, key: "p102-cover", url: "https://picsum.photos/id/1021/1200/800", alt: "Siargao Bay Suites", isCover: true,  sortOrder: 1 },
    { partnerId: 102, key: "p102-g1",    url: "https://picsum.photos/id/1022/1200/800", alt: "Siargao Bay Suites",                  sortOrder: 2 },

    { partnerId: 103, key: "p103-cover", url: "https://picsum.photos/id/1031/1200/800", alt: "Pacifico Breeze Villas", isCover: true,  sortOrder: 1 },
    { partnerId: 103, key: "p103-g1",    url: "https://picsum.photos/id/1032/1200/800", alt: "Pacifico Breeze Villas",               sortOrder: 2 },

    { partnerId: 104, key: "p104-cover", url: "https://picsum.photos/id/1041/1200/800", alt: "Daku Island Retreat",  isCover: true,  sortOrder: 1 },
    { partnerId: 104, key: "p104-g1",    url: "https://picsum.photos/id/1042/1200/800", alt: "Daku Island Retreat",                 sortOrder: 2 },

    { partnerId: 105, key: "p105-cover", url: "https://picsum.photos/id/1051/1200/800", alt: "Magpupungko Tide Inn", isCover: true,  sortOrder: 1 },
    { partnerId: 105, key: "p105-g1",    url: "https://picsum.photos/id/1052/1200/800", alt: "Magpupungko Tide Inn",                sortOrder: 2 },

    { partnerId: 106, key: "p106-cover", url: "https://picsum.photos/id/1061/1200/800", alt: "Naked Island Cabins",  isCover: true,  sortOrder: 1 },
    { partnerId: 106, key: "p106-g1",    url: "https://picsum.photos/id/1062/1200/800", alt: "Naked Island Cabins",                 sortOrder: 2 },
    { partnerId: 2,   key: "p2-cover",  url: "https://picsum.photos/id/1021/1200/800", alt: "Siargao Bay Suites",  isCover: true,  sortOrder: 0 },
    { partnerId: 2,   key: "p2-g1",     url: "https://picsum.photos/id/1022/1200/800", alt: "Siargao Bay Suites",                   sortOrder: 1 },
  ];

  // PropertyProfile: partnerId is @unique in your schema — safe for upsert
  for (const p of profiles) {
    await prisma.propertyProfile.upsert({
      where:  { partnerId: p.partnerId },
      create: { partnerId: p.partnerId, name: p.name, city: p.city, country: p.country },
      update: { name: p.name, city: p.city, country: p.country },
    });
  }

  // PropertyPhoto: key is unique — use upsert for idempotency
  for (const ph of photos) {
    await prisma.propertyPhoto.upsert({
      where:  { key: ph.key },
      create: {
        partnerId: ph.partnerId,
        key: ph.key,
        url: ph.url,
        alt: ph.alt ?? null,
        sortOrder: ph.sortOrder ?? 0,
        isCover: ph.isCover ?? false,
      },
      update: {
        url: ph.url,
        alt: ph.alt ?? null,
        sortOrder: ph.sortOrder ?? 0,
        isCover: ph.isCover ?? false,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// ANCHOR: SEED_PROFILES_AND_PHOTOS
