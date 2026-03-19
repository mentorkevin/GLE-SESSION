import { createRequire } from "module";
const require = createRequire(import.meta.url);

const Mega = require("megajs");

const storage = Mega({
  email: "mentorkevinofficial@gmail.com",
  password: "22668011Anna"
});

storage.on("ready", async () => {
  console.log("✅ Logged into Mega");

  // 🔥 THIS IS THE CORRECT WAY
  const session = storage.export();

  console.log("\n🔐 MEGA SESSION STRING:\n");
  console.log(session);
});

storage.on("error", (err) => {
  console.error("❌ Mega Error:", err);
});