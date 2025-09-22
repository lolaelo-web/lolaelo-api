// data/siargao_hotels.js
// Mock Siargao hotels + deterministic availability generator (extranet-only)

function mulberry32(a){return function(){var t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
function toISO(d){return d.toISOString().slice(0,10)}
function parseISO(s){return new Date(s+"T00:00:00Z")}
function daysBetween(sISO,eISO){
  const s=parseISO(sISO), e=parseISO(eISO); const out=[];
  for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)) out.push(toISO(new Date(d)));
  return out;
}

const CURRENCY = "USD";

const HOTELS = [
  {
    id: 101,
    name: "Cloud 9 Surf House",
    slug: "cloud-9-surf-house",
    address: "Cloud 9 Boardwalk, General Luna, Siargao",
    city: "General Luna",
    country: "Philippines",
    lat: 9.8042, lng: 126.1716, starRating: 3,
    amenities: ["beachfront","wifi","aircon","bar","airport-shuttle"],
    images: [
      "https://picsum.photos/seed/cloud9a/1280/720",
      "https://picsum.photos/seed/cloud9b/1280/720"
    ],
    rooms: [{ id: 1001, name: "Ocean View Queen", maxGuests: 2, basePrice: 149.00 }]
  },
  {
    id: 102,
    name: "General Luna Garden Villas",
    slug: "general-luna-garden-villas",
    address: "Tourism Rd, General Luna, Siargao",
    city: "General Luna",
    country: "Philippines",
    lat: 9.7848, lng: 126.1652, starRating: 4,
    amenities: ["pool","wifi","aircon","breakfast","parking"],
    images: [
      "https://picsum.photos/seed/glgarden1/1280/720",
      "https://picsum.photos/seed/glgarden2/1280/720"
    ],
    rooms: [{ id: 1002, name: "Garden Villa King", maxGuests: 3, basePrice: 179.00 }]
  },
  {
    id: 103,
    name: "Pacifico Beach Lodge",
    slug: "pacifico-beach-lodge",
    address: "Pacifico, San Isidro, Siargao",
    city: "San Isidro",
    country: "Philippines",
    lat: 10.0758, lng: 126.2015, starRating: 3,
    amenities: ["beachfront","wifi","restaurant","surf-rentals"],
    images: [
      "https://picsum.photos/seed/pbl1/1280/720",
      "https://picsum.photos/seed/pbl2/1280/720"
    ],
    rooms: [{ id: 1003, name: "Beachfront Twin", maxGuests: 2, basePrice: 129.00 }]
  },
  {
    id: 104,
    name: "Dapa Bay Boutique Inn",
    slug: "dapa-bay-boutique-inn",
    address: "Port Rd, Dapa, Siargao",
    city: "Dapa",
    country: "Philippines",
    lat: 9.7597, lng: 126.0460, starRating: 3,
    amenities: ["wifi","aircon","harbor-view","breakfast"],
    images: [
      "https://picsum.photos/seed/dapa1/1280/720",
      "https://picsum.photos/seed/dapa2/1280/720"
    ],
    rooms: [{ id: 1004, name: "Harbor View Double", maxGuests: 2, basePrice: 109.00 }]
  },
  {
    id: 105,
    name: "Naked Island Eco Resort",
    slug: "naked-island-eco-resort",
    address: "Naked Island Jump-off, General Luna, Siargao",
    city: "General Luna",
    country: "Philippines",
    lat: 9.7660, lng: 126.2010, starRating: 2,
    amenities: ["eco","wifi","fan-room","beach-access"],
    images: [
      "https://picsum.photos/seed/naked1/1280/720",
      "https://picsum.photos/seed/naked2/1280/720"
    ],
    rooms: [{ id: 1005, name: "Eco Hut", maxGuests: 2, basePrice: 79.00 }]
  },
  {
    id: 106,
    name: "Guyam Grove Bungalows",
    slug: "guyam-grove-bungalows",
    address: "Guyam-facing Strip, General Luna, Siargao",
    city: "General Luna",
    country: "Philippines",
    lat: 9.7411, lng: 126.1659, starRating: 3,
    amenities: ["wifi","aircon","bar","kayak-rentals"],
    images: [
      "https://picsum.photos/seed/guyam1/1280/720",
      "https://picsum.photos/seed/guyam2/1280/720"
    ],
    rooms: [{ id: 1006, name: "Bungalow Queen", maxGuests: 2, basePrice: 139.00 }]
  }
];

// Generate daily availability/prices (extranet-like)
function generateDailyForRoom({ room, start, end, seedBase=1 }) {
  const days = daysBetween(start, end);
  const rng = mulberry32(seedBase + room.id);
  const out = [];
  for (let i=0;i<days.length;i++){
    const date = days[i];
    const dt = parseISO(date);
    const dow = dt.getUTCDay(); // 0 Sun ... 6 Sat
    const weekend = (dow===5 || dow===6);    // Fri/Sat bump
    // stock/open: between 0..5 with some shape
    const open = Math.max(0, Math.floor(rng()*6) - (weekend ? 0 : 0));
    const closed = open === 0 && rng() < 0.4;
    // minStay: weekends a bit higher
    const minStay = weekend ? (rng()<0.5 ? 2 : 3) : 1;
    // price: base ± jitter + weekend uplift
    const jitter = (rng() - 0.5) * 8; // ±$4
    const uplift = weekend ? room.basePrice*0.12 : 0; // +12% on Fri/Sat
    const price = closed ? null : Number((room.basePrice + uplift + jitter).toFixed(2));

    out.push({ date, open, minStay, closed, price });
  }
  return out;
}

// One-property detailed availability (matches earlier contract)
function getAvailability({ propertyId, start, end, ratePlanId=1, currency=CURRENCY }) {
  const prop = HOTELS.find(h => h.id === Number(propertyId));
  if (!prop) return null;
  const room = prop.rooms[0]; // one room-type per property for mock
  const daily = generateDailyForRoom({ room, start, end, seedBase: prop.id });

  const pricedDays = daily.filter(d => !d.closed && d.open > 0 && typeof d.price === 'number');
  const fromPrice = pricedDays.length ? Math.min(...pricedDays.map(d => d.price)) : null;
  const fromPriceStr = fromPrice != null ? `$${fromPrice.toFixed(2)}` : null;
  const availableNights = daily.filter(d => !d.closed && d.open > 0).length;

  return {
    propertyId: prop.id,
    start, end,
    ratePlanId: Number(ratePlanId) || 1,
    currency,
    rooms: [{
      id: room.id,
      name: room.name,
      maxGuests: room.maxGuests,
      images: prop.images,
      fromPrice,
      fromPriceStr,
      availableNights,
      nightsTotal: daily.length,
      daily
    }],
    meta: {
      generatedAt: new Date().toISOString(),
      cacheTtlSec: 600,
      property: {
        id: prop.id, name: prop.name, slug: prop.slug,
        address: prop.address, city: prop.city, country: prop.country,
        lat: prop.lat, lng: prop.lng, starRating: prop.starRating,
        amenities: prop.amenities, images: prop.images
      }
    }
  };
}

// Multi-property search summary for a date range
function searchAvailability({ start, end, ratePlanId=1, currency=CURRENCY }) {
  const list = HOTELS.map(prop => {
    const room = prop.rooms[0];
    const daily = generateDailyForRoom({ room, start, end, seedBase: prop.id });
    const pricedDays = daily.filter(d => !d.closed && d.open > 0 && typeof d.price === 'number');
    const fromPrice = pricedDays.length ? Math.min(...pricedDays.map(d => d.price)) : null;
    const availableNights = daily.filter(d => !d.closed && d.open > 0).length;
    return {
      propertyId: prop.id,
      name: prop.name,
      slug: prop.slug,
      city: prop.city,
      country: prop.country,
      lat: prop.lat,
      lng: prop.lng,
      starRating: prop.starRating,
      amenities: prop.amenities,
      images: prop.images,
      fromPrice,
      fromPriceStr: fromPrice != null ? `$${fromPrice.toFixed(2)}` : null,
      availableNights,
      nightsTotal: daily.length
    };
  });
  return {
    start, end,
    ratePlanId: Number(ratePlanId) || 1,
    currency,
    properties: list,
    meta: { generatedAt: new Date().toISOString(), cacheTtlSec: 600 }
  };
}
// Normalize image fields so UIs can always rely on `photos[]` and `thumbnail`
HOTELS.forEach(h => {
  if (!Array.isArray(h.photos) || h.photos.length === 0) {
    h.photos = Array.isArray(h.images) ? h.images.slice() : [];
  }
  if (!h.thumbnail && h.photos.length) {
    h.thumbnail = h.photos[0];
  }
});

module.exports = { CURRENCY, HOTELS, getAvailability, searchAvailability };
