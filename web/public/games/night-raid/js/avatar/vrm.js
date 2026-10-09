// Night Raid: who stands on deck, and how their models load.
//
// The Rexmaw's crew are the app's five stock companions (server/seeds.py
// AGENT_SEEDS: Eve, Ara, Rex, Sal, Leo, each linked to the bundled avatar
// pack of the same name). The user may have renamed, restyled or deleted
// them, or made companions of their own, so the crew is found by name in
// /api/voice/agents (the list every picker reads: avatar.vrm_url, outfits,
// current_outfit_id) and each member wears whatever outfit they have on right
// now. A member missing from the list falls back to their bundled pack's
// default model (/assets/avatars/<Name>/…, in git), and from there to the
// paper standee.
//
// The companion playing (agentId) is the first mate. If they ARE one of the
// five (by agent id, else by name), that member is the companion; otherwise
// all five are crew and the companion is an extra figure, "me".
//
// loadVrm is Night Helm's recipe (Starboard's loader): three-vrm plugins,
// removeUnnecessaryVertices + combineSkeletons, no frustum culling, faced
// onto +Z by lookAt.faceFront (VRM 0 faces −Z, VRM 1 +Z when it has none),
// native scale unless the rig is oddly sized (then fit to 1.65 m, spring
// bones scaled with it), feet on the deck. No rim light and no glow on any
// avatar: the night look only lifts MToon's shades a touch.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

/** The five, in the order they load after the companion. */
export const CREW_IDS = Object.freeze(["rex", "eve", "ara", "sal", "leo"]);

/** Names, roles (crew/lines.json) and bundled packs (assets/avatars/<Name>/avatar.json `vrm`). */
export const CREW_INFO = Object.freeze({
  rex: Object.freeze({ name: "Rex", role: "Quartermaster", pack: "/assets/avatars/Rex/CaptainLobster" }),
  eve: Object.freeze({ name: "Eve", role: "Chartkeeper", pack: "/assets/avatars/Eve/eve_doctors_coat" }),
  ara: Object.freeze({ name: "Ara", role: "Steward", pack: "/assets/avatars/Ara/ara_casual_default" }),
  sal: Object.freeze({ name: "Sal", role: "Engineer", pack: "/assets/avatars/Sal/Froggy" }),
  leo: Object.freeze({ name: "Leo", role: "Officer of the watch", pack: "/assets/avatars/Leo/leo_fancy_suit" }),
});

const HEIGHT_RANGE = [0.6, 2.6]; // metres: outside this the rig's scale is wrong
const HEIGHT_FIT = 1.65;

// Night look (runtime only; the model file is never touched). No rim, no emissive.
const SHADE_LIFT = new THREE.Color("#1a2240");
const SHADE_LIFT_AMOUNT = 0.18;
const TOONY_MAX = 0.75;
const SHIFT_MAX = -0.05;

/** Every agent the app has (POST /api/voice/agents), or [] when the server can't say. */
export async function fetchAgents() {
  try {
    const r = await fetch("/api/voice/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const res = await r.json();
    return Array.isArray(res?.agents) ? res.agents : [];
  } catch (error) {
    console.debug("[night-raid] crew: agent list unavailable; the bundled crew stands in", error);
    return [];
  }
}

/** What an agent has on right now: model, idle, pictures. */
export function avatarUrls(agent) {
  const av = agent?.avatar || null;
  const outfits = Array.isArray(av?.outfits) ? av.outfits : [];
  const outfit = outfits.find((o) => o.id === agent?.current_outfit_id) || outfits.find((o) => o.id === 0) || null;
  return {
    name: agent?.name || "",
    vrmUrl: outfit?.vrm_url || av?.vrm_url || null,
    idleUrl: av?.vrma_idle_url || null,
    // The outfit on now only: another outfit's picture would put the standee in the wrong clothes.
    portraitUrl: outfit?.portrait_url || null,
    fullbodyUrl: outfit?.fullbody_url || null,
  };
}

/** The bundled pack's default look for a crew member (the agent is gone or has no avatar). */
function bundledUrls(id) {
  const info = CREW_INFO[id];
  return { name: info.name, vrmUrl: `${info.pack}.vrm`, idleUrl: null, portraitUrl: `${info.pack}.portrait.png`, fullbodyUrl: `${info.pack}.fullbody.png` };
}

/**
 * Who stands on deck: the five crew plus, when the companion isn't one of them, "me".
 * @param {{agentId?: number|null, agents?: object[]|null, members?: string[]|null}} opts
 *   `members` limits the cast (ids from CREW_IDS and/or "me"); default: everyone.
 * @returns {Promise<{cast: Array<{id: string, name: string, role: string, agentId: number|null, urls: object,
 *   isCompanion: boolean}>, companionId: string|null}>}  companion first, then the crew in CREW_IDS order.
 */
export async function resolveCast({ agentId = null, agents = null, members = null } = {}) {
  const list = Array.isArray(agents) ? agents : await fetchAgents();
  const byName = (name) => {
    const same = list.filter((a) => String(a?.name || "").trim().toLowerCase() === name.toLowerCase());
    // A stock companion and a later one of the same name: the one with a model, oldest first.
    same.sort((a, b) => (avatarUrls(b).vrmUrl ? 1 : 0) - (avatarUrls(a).vrmUrl ? 1 : 0) || Number(a.id) - Number(b.id));
    return same[0] || null;
  };
  const companion = agentId != null ? list.find((a) => Number(a.id) === Number(agentId)) || null : null;
  const cast = [];
  let companionId = null;
  for (const id of CREW_IDS) {
    const info = CREW_INFO[id];
    let agent = byName(info.name);
    let isCompanion = false;
    if (companion && (Number(companion.id) === Number(agent?.id) || (!agent && String(companion.name || "").trim().toLowerCase() === info.name.toLowerCase()))) {
      agent = companion; isCompanion = true; companionId = id;
    }
    const urls = agent ? avatarUrls(agent) : bundledUrls(id);
    if (!urls.vrmUrl) Object.assign(urls, { vrmUrl: bundledUrls(id).vrmUrl });
    if (!urls.portraitUrl) urls.portraitUrl = bundledUrls(id).portraitUrl;
    cast.push({ id, name: agent?.name || info.name, role: info.role, agentId: agent ? Number(agent.id) : null, urls, isCompanion });
  }
  if (!companionId && agentId != null) {
    const urls = companion ? avatarUrls(companion) : { name: "", vrmUrl: null, idleUrl: null, portraitUrl: null, fullbodyUrl: null };
    cast.push({ id: "me", name: companion?.name || "First mate", role: "First mate", agentId: Number(agentId), urls, isCompanion: true });
    companionId = "me";
  }
  const wanted = Array.isArray(members) && members.length ? cast.filter((m) => members.includes(m.id) || (m.isCompanion && members.includes("me"))) : cast;
  // The companion loads first: the one the player looks for.
  wanted.sort((a, b) => (b.isCompanion ? 1 : 0) - (a.isCompanion ? 1 : 0));
  return { cast: wanted, companionId: wanted.some((m) => m.id === companionId) ? companionId : null };
}

/** Night-lifted shades on every MToon material (runtime only); rims, emissive and outlines are left as they are. */
function nightLook(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!m?.isMToonMaterial || m.isOutline) continue;
      const hair = /hair/i.test(m.name || "");
      m.shadeColorFactor?.lerp(SHADE_LIFT, SHADE_LIFT_AMOUNT);
      if (!hair) {
        m.shadingToonyFactor = Math.min(m.shadingToonyFactor, TOONY_MAX);
        m.shadingShiftFactor = Math.min(m.shadingShiftFactor, SHIFT_MAX);
      }
    }
  });
}

/**
 * Load a VRM into a holder whose origin is the feet and whose +Z is the face.
 * @param {string} url @param {number} layer
 * @param {(fraction: number) => void} [onProgress]  bytes loaded, 0..1 (when the server says how many)
 * @returns {Promise<{vrm: import("@pixiv/three-vrm").VRM, holder: THREE.Group, top: number, bytes: number}>}
 */
export async function loadVrm(url, layer, onProgress = null) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  let bytes = 0;
  const gltf = await loader.loadAsync(url, (e) => {
    bytes = e?.loaded || bytes;
    if (e?.total > 0) { try { onProgress?.(Math.min(1, e.loaded / e.total)); } catch { /* */ } }
  });
  const vrm = gltf.userData?.vrm;
  if (!vrm) {
    try { VRMUtils.deepDispose(gltf.scene); } catch { /* */ }
    throw new Error("the file has no VRM in it");
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.traverse((obj) => {
    obj.layers.set(layer);
    if (obj.isMesh) { obj.frustumCulled = false; obj.castShadow = true; obj.receiveShadow = true; }
  });
  const faceFront = vrm.lookAt?.faceFront;
  if (faceFront) {
    vrm.scene.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(faceFront.clone().normalize(), new THREE.Vector3(0, 0, 1)));
  } else {
    vrm.scene.rotation.y = vrm.meta?.metaVersion === "1" ? 0 : Math.PI;
  }
  nightLook(vrm.scene);
  const holder = new THREE.Group();
  holder.name = "crew-vrm";
  holder.add(vrm.scene);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const height = box.max.y - box.min.y;
  const s = Number.isFinite(height) && (height < HEIGHT_RANGE[0] || height > HEIGHT_RANGE[1]) ? HEIGHT_FIT / height : 1;
  vrm.scene.scale.multiplyScalar(s);
  if (s !== 1 && vrm.springBoneManager) {
    const settings = new Set(), shapes = new Set();
    for (const j of vrm.springBoneManager.joints) {
      settings.add(j.settings);
      for (const g of j.colliderGroups) for (const c of g.colliders) shapes.add(c.shape);
    }
    for (const st of settings) { st.hitRadius *= s; st.stiffness *= s; st.gravityPower *= s; }
    for (const sh of shapes) if (typeof sh.radius === "number") sh.radius *= s;
  }
  if (Number.isFinite(box.min.y)) vrm.scene.position.y = -box.min.y * s;
  // The half-width (for picking), from the same box.
  const half = Number.isFinite(box.max.x) ? Math.max(0.2, Math.min(0.6, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * s * 0.35)) : 0.32;
  return { vrm, holder, top: Number.isFinite(height) ? height * s : HEIGHT_FIT, half, bytes };
}

/** MToon outlines on (true) or off (Low quality); remembers what each outline material was. */
export function setOutlines(root, on) {
  root?.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (m?.isMToonMaterial && m.isOutline) m.visible = !!on;
    }
  });
}
