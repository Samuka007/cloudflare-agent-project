/**
 * Legacy DO stubs — deployment-transition scaffolding ONLY (deploy two-step
 * for the #590 retirement, see wrangler.jsonc migrations note).
 *
 * The #590 wave deleted the legacy agent loop implementation, but Cloudflare
 * refuses a script swap while live Durable Object instances depend on a class
 * the script stops exporting (error 10064), and refuses --delete-class while
 * any binding still references the class (error 10061). The clean sequence:
 *
 *   1. this commit: export empty stubs under the legacy names (bindings are
 *      already swapped to ComposedDurableAgentDO — the stubs are unbound and
 *      inert) so the pi-durable worker can finally ship;
 *   2. immediate follow-up commit: drop these stubs AND restore the v3
 *      deleted_classes migration — with zero bindings left, Cloudflare
 *      deletes the dormant instances and their storage cleanly.
 *
 * Remove this file in step 2. Never bind these classes anywhere.
 */
import { DurableObject } from "cloudflare:workers";

export class ComposedAgentDO extends DurableObject {}

export class ComposedHostOrchestratorDO extends DurableObject {}

export class ManagerDo extends DurableObject {}
