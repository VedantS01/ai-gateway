import http from "node:http";
import fs from "node:fs";
const mode = () => { try { return fs.readFileSync(process.env.MODE_FILE, "utf8").trim(); } catch { return "ok"; } };
http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const m = mode();
    const auth = req.headers.authorization;
    if (m === "down") { res.writeHead(503, {"content-type":"application/json"}); return res.end('{"error":{"message":"mock down"}}'); }
    if (m === "busy" && auth === "Bearer key-one") { res.writeHead(429, {"content-type":"application/json"}); return res.end('{"error":{"message":"mock busy"}}'); }
    const body = JSON.parse(raw);
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({ id: "mock", model: body.model, auth, fields: Object.keys(body).sort(),
      choices: [{ message: { role: "assistant", content: JSON.stringify({ echo: body.messages.at(-1).content }) }, finish_reason: "stop" }] }));
  });
}).listen(18089, () => console.log("mock up"));
