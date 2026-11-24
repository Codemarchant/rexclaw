// The pets and mounts in the room view: their rigged models (assets/toys/
// pets/<id>.glb, built by tools/pets/build_pets.py) loaded, given the toys'
// toon shading (models/toys/models3d.js), and handed a rig that moves their
// bones (models/toys/pet_rig.js).
//
// A model arrives a moment after its toy does, so the stage gets an empty
// group at once (models3d.js buildToyModel) and the animal appears in it
// when it's ready, popping in like any toy.

import { toonRamp } from "./models3d";
import { createPetRig } from "./pet_rig";

const URL = (id) => `/assets/toys/pets/${id}.glb`;

/** Load animal `def`'s model into `group` (the toy's own, its origin the
 *  toy's centre: the model is set down so its feet are on the sphere's
 *  bottom, a swimmer's middle on its middle). Resolves to its rig, or null
 *  if it couldn't be loaded. `loader`: a GLTFLoader. */
export async function attachPet(THREE, loader, def, group, radius = def.radius) {
    const spec = def.pet || def.mount;
    try {
        const gltf = await loader.loadAsync(URL(spec.model || def.id));
        return rigged(THREE, gltf, def, spec, group, radius);
    } catch (e) {
        console.error("[toys] pet model failed to load", def.id, e);
        return null;
    }
}

function rigged(THREE, gltf, def, spec, group, radius) {
    const root = gltf.scene;
    // The model's own notes ride on its top node (the builder's extras).
    const meta = root.children.find((c) => c.userData?.pet)?.userData.pet || root.userData?.pet || {};
    root.traverse((o) => {
        if (!o.isMesh) return;
        // (A skinned mesh's bounds don't follow its bones.)
        o.frustumCulled = false;
        const glow = o.material?.name === "glow";
        o.material = glow ? new THREE.MeshBasicMaterial({ vertexColors: true })
            : new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp(THREE) });
        o.castShadow = !glow;
        o.receiveShadow = !glow;
    });
    const k = spec.scale || 1;
    root.scale.setScalar(k);
    root.position.y = meta.floats ? 0 : -radius;
    group.add(root);
    const rig = createPetRig(THREE, root, meta, spec.style || {});
    rig.scale = k;
    return rig;
}
