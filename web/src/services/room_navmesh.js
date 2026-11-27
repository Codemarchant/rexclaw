/**
 * A 3D scene's navigation mesh: where feet may go.
 *
 * A scene file (GLB) can carry one the way levels built for game engines
 * do: a plain mesh laid over the walkable floor, kept clear of walls and
 * furniture by about a body's half width. It is marked by its node name —
 * the "-navmesh" import suffix (also "_navmesh" / "$navmesh", any case),
 * or simply "navmesh" / "nav-mesh" — or by a "nav-mesh" component on the
 * node. It is never drawn. Walking is held to it and routed across it; a
 * scene without one keeps the open play area.
 *
 * It is read as a floor plan: where they may stand, not how high. The
 * floor stays the one level the rest of the stage is built on.
 */
import { Pathfinding } from "three-pathfinding";

const ZONE = "room";
const NAME = /(^|[-_$])nav[-_]?mesh$/i;
const INSIDE = 0.01;   // m — the mesh is welded to the centimetre; a point brought in from outside lands this far inside

function marked(node) {
    return NAME.test(node.userData?.name || "") || NAME.test(node.name || "")
        || !!node.userData?.gltfExtensions?.MOZ_hubs_components?.["nav-mesh"];
}

export class RoomNavMesh {
    /** The navigation mesh a loaded scene carries (hidden here), or null.
     *  `scene` is in place already: its world matrices are current. */
    static fromScene(scene, THREE) {
        const meshes = new Set();
        scene.traverse((node) => {
            if (!marked(node)) return;
            node.visible = false;
            node.traverse((m) => { if (m.isMesh) meshes.add(m); });
        });
        if (!meshes.size) return null;
        const positions = [];
        const v = new THREE.Vector3();
        for (const mesh of meshes) {
            const at = mesh.geometry.attributes.position;
            const index = mesh.geometry.index;
            const count = index ? index.count : at.count;
            for (let i = 0; i < count; i++) {
                v.fromBufferAttribute(at, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
                positions.push(v.x, v.y, v.z);
            }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        try {
            const nav = new RoomNavMesh(THREE, Pathfinding.createZone(geometry));
            return nav._tris.length ? nav : null;
        } catch (e) {
            console.warn("[voice] scene navigation mesh unusable", e);
            return null;
        } finally {
            geometry.dispose();
        }
    }

    constructor(THREE, zone) {
        this._THREE = THREE;
        this._pathfinding = new Pathfinding();
        this._pathfinding.setZoneData(ZONE, zone);
        this._point = new THREE.Vector3();
        this._near = new THREE.Vector3();
        // Every triangle in plan view (y = 0), with its box for a quick miss.
        this._tris = [];
        zone.groups.forEach((nodes, group) => {
            for (const node of nodes) {
                const [a, b, c] = node.vertexIds.map((id) => zone.vertices[id]);
                this._tris.push({
                    group,
                    y: node.centroid.y,
                    cx: node.centroid.x, cz: node.centroid.z,
                    tri: new THREE.Triangle(
                        new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(b.x, 0, b.z), new THREE.Vector3(c.x, 0, c.z)),
                    minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
                    minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z),
                });
            }
        });
    }

    /** The nearest walkable spot to (x, z) — the spot itself when it is one
     *  already. `group` keeps to one connected part of the mesh. */
    _locate(x, z, group = null) {
        const p = this._point.set(x, 0, z);
        let best = Infinity;
        let hit = null;
        let hx = x, hz = z;
        for (const t of this._tris) {
            if (group != null && t.group !== group) continue;
            const dx = Math.max(t.minX - x, 0, x - t.maxX);
            const dz = Math.max(t.minZ - z, 0, z - t.maxZ);
            if (dx * dx + dz * dz >= best) continue;
            t.tri.closestPointToPoint(p, this._near);
            const d = this._near.distanceToSquared(p);
            if (d < best) {
                best = d; hit = t; hx = this._near.x; hz = this._near.z;
                if (d === 0) break;
            }
        }
        return hit && { x: hx, z: hz, off: Math.sqrt(best), tri: hit };
    }

    /** Hold a floor position (anything with x and z) to the mesh. */
    clamp(pos) {
        const at = this._locate(pos.x, pos.z);
        if (at?.off) { pos.x = at.x; pos.z = at.z; }
        return pos;
    }

    /** The way from one floor spot to another across the mesh: the corners
     *  to turn at and, last, the destination (brought onto the mesh, in the
     *  part of it the walk starts from). Null when there is no way. */
    route(fromX, fromZ, toX, toZ) {
        const { Vector3 } = this._THREE;
        const start = this._locate(fromX, fromZ);
        const end = start && this._locate(toX, toZ, start.tri.group);
        if (!end) return null;
        // The path finder wants both ends inside a triangle, not on its rim.
        const inside = (at) => {
            const dx = at.tri.cx - at.x, dz = at.tri.cz - at.z;
            const k = at.off ? Math.min(1, INSIDE / (Math.hypot(dx, dz) || 1)) : 0;
            return new Vector3(at.x + dx * k, at.tri.y, at.z + dz * k);
        };
        let path = null;
        try {
            path = this._pathfinding.findPath(inside(start), inside(end), ZONE, start.tri.group);
        } catch (e) { /* no way found — the caller walks straight, held to the mesh */ }
        return path?.length ? path.map((p) => new Vector3(p.x, 0, p.z)) : null;
    }
}
