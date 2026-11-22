// Border-collie pet plugin entry. The Host half lives in pet-service.js as a plain function
// plugin (no host-internal imports). Client wiring stays in client.js (declared via
// package.json dsh.client.inject).

export { name, inject, apply, BUILD } from "./pet-service.js";
