import { isHueError } from '../errors.js';
import { parseBridgeInfo, parseGroups, parseLights, parseScenes } from '../parse.js';
import type { HueRequest, HueTransport } from '../types.js';

const seg = (id: string): string => encodeURIComponent(id);

/** Builds the typed transport API on top of a single `request` function. */
export function transportOver(
  kind: HueTransport['kind'],
  label: string,
  request: (r: HueRequest) => Promise<unknown>,
): HueTransport {
  return {
    kind,
    label,
    request,
    async getLights() {
      return parseLights(await request({ method: 'GET', path: '/lights' }));
    },
    async getV2Lights() {
      try {
        const body = await request({ method: 'GET', path: '/resource/light', v2: true });
        const data = (body as { data?: unknown } | null)?.data;
        return Array.isArray(data) ? data : [];
      } catch (e) {
        // "Cannot do v2" is an answer ([]); anything else is a failed read.
        if (isHueError(e, 'unsupported')) return [];
        throw e;
      }
    },
    async getGroups() {
      return parseGroups(await request({ method: 'GET', path: '/groups' }));
    },
    async getScenes() {
      return parseScenes(await request({ method: 'GET', path: '/scenes' }));
    },
    async getBridgeInfo() {
      return parseBridgeInfo(await request({ method: 'GET', path: '/config' }));
    },
    async setLight(id, state, options) {
      await request({ method: 'PUT', path: `/lights/${seg(id)}/state`, body: state, signal: options?.signal });
    },
    async setGroup(id, state, options) {
      await request({ method: 'PUT', path: `/groups/${seg(id)}/action`, body: state, signal: options?.signal });
    },
    async recallScene(groupId, sceneId, options) {
      await request({
        method: 'PUT',
        path: `/groups/${seg(groupId)}/action`,
        body: { scene: sceneId },
        signal: options?.signal,
      });
    },
    async writeV2(v2Id, body, options) {
      await request({ method: 'PUT', path: `/resource/light/${seg(v2Id)}`, body, v2: true, signal: options?.signal });
    },
  };
}
