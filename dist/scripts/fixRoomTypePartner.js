// src/scripts/fixRoomTypePartner.ts
import { Client } from "pg";
async function main() {
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error("DATABASE_URL is not set.");
    const roomTypeId = Number(process.argv[2] || 1);
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log(`\n--- Inspect roomTypeId=${roomTypeId} ---`);
    const rt = await client.query(`SELECT "id","partnerId","name" FROM extranet."RoomType" WHERE "id" = $1`, [roomTypeId]);
    console.table(rt.rows);
    let partnerId = rt.rows?.[0]?.partnerId ?? null;
    if (!partnerId) {
        console.log("\nRoomType.partnerId is NULL. Looking up from RatePlan…");
        const rr = await client.query(`SELECT MIN("partnerId") AS partner_id
         FROM extranet."RatePlan"
        WHERE "roomTypeId" = $1`, [roomTypeId]);
        partnerId = rr.rows?.[0]?.partner_id ?? null;
        if (partnerId) {
            const upd = await client.query(`UPDATE extranet."RoomType" SET "partnerId" = $1 WHERE "id" = $2`, [partnerId, roomTypeId]);
            console.log(`\nUpdated RoomType.partnerId -> ${partnerId} (rows: ${upd.rowCount})`);
        }
        else {
            console.log("\nNo RatePlan found to infer partnerId.");
        }
    }
    else {
        console.log("\nRoomType already has partnerId.");
    }
    const finalCheck = await client.query(`SELECT "id","partnerId","name" FROM extranet."RoomType" WHERE "id" = $1`, [roomTypeId]);
    console.log("\n--- Final RoomType row ---");
    console.table(finalCheck.rows);
    await client.end();
    console.log("\n✅ Done.");
}
main().catch((e) => {
    console.error("❌ Fatal:", e);
    process.exit(1);
});
