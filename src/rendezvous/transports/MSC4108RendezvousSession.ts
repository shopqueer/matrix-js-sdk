/*
Copyright 2024 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { logger } from "../../logger";
import { sleep } from "../../utils";
import { RendezvousFailureListener, RendezvousFailureReason } from "..";
import { MatrixClient } from "../../matrix";
import { ClientPrefix } from "../../http-api";

/**
 * Prototype of the unstable [4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108)
 * insecure rendezvous session protocol.
 * Note that this is UNSTABLE and may have breaking changes without notice.
 */
export class MSC4108RendezvousSession {
    public url?: string;
    private etag?: string;
    private expiresAt?: Date;
    private client?: MatrixClient;
    private fallbackRzServer?: string;
    private fetchFn?: typeof global.fetch;
    private cancelled = false;
    private _ready = false;
    public onFailure?: RendezvousFailureListener;

    public constructor({
        onFailure,
        url,
        fetchFn,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        url: string;
    });
    public constructor({
        onFailure,
        client,
        fallbackRzServer,
        fetchFn,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        client?: MatrixClient;
        fallbackRzServer?: string;
    });
    public constructor({
        fetchFn,
        onFailure,
        url,
        client,
        fallbackRzServer,
    }: {
        fetchFn?: typeof global.fetch;
        onFailure?: RendezvousFailureListener;
        url?: string;
        client?: MatrixClient;
        fallbackRzServer?: string;
    }) {
        this.fetchFn = fetchFn;
        this.onFailure = onFailure;
        this.client = client;
        this.fallbackRzServer = fallbackRzServer;
        this.url = url;
    }

    public get ready(): boolean {
        return this._ready;
    }

    private fetch(resource: URL | string, options?: RequestInit): ReturnType<typeof global.fetch> {
        if (this.fetchFn) {
            return this.fetchFn(resource, options);
        }
        return global.fetch(resource, options);
    }

    private async getPostEndpoint(): Promise<string | undefined> {
        if (this.client) {
            try {
                // whilst prototyping we can use the MSC3886 endpoint if available
                if (await this.client.doesServerSupportUnstableFeature("org.matrix.msc3886")) {
                    return `${this.client.baseUrl}${ClientPrefix.Unstable}/org.matrix.msc3886/rendezvous`;
                }
                if (await this.client.doesServerSupportUnstableFeature("org.matrix.msc4108")) {
                    return `${this.client.baseUrl}${ClientPrefix.Unstable}/org.matrix.msc4108/rendezvous`;
                }
            } catch (err) {
                logger.warn("Failed to get unstable features", err);
            }
        }

        return this.fallbackRzServer;
    }

    public async send(data: string): Promise<void> {
        if (this.cancelled) {
            return;
        }
        const method = this.url ? "PUT" : "POST";
        const uri = this.url ?? (await this.getPostEndpoint());

        if (!uri) {
            throw new Error("Invalid rendezvous URI");
        }

        const headers: Record<string, string> = { "content-type": "text/plain" };
        if (this.etag) {
            headers["if-match"] = this.etag;
        }

        logger.info(`=> ${method} ${uri} with ${data} if-match: ${this.etag}`);

        const res = await this.fetch(uri, { method, headers, body: data });
        if (res.status === 404) {
            return this.cancel(RendezvousFailureReason.Unknown);
        }
        this.etag = res.headers.get("etag") ?? undefined;

        logger.info(`Received etag: ${this.etag}`);

        if (method === "POST") {
            const location = res.headers.get("location");
            if (!location) {
                throw new Error("No rendezvous URI given");
            }
            const expires = res.headers.get("expires");
            if (expires) {
                this.expiresAt = new Date(expires);
            }
            // we would usually expect the final `url` to be set by a proper fetch implementation.
            // however, if a polyfill based on XHR is used it won't be set, we we use existing URI as fallback
            const baseUrl = res.url ?? uri;
            // resolve location header which could be relative or absolute
            this.url = new URL(location, `${baseUrl}${baseUrl.endsWith("/") ? "" : "/"}`).href;
            this._ready = true;
        }
    }

    public async receive(): Promise<string | undefined> {
        if (!this.url) {
            throw new Error("Rendezvous not set up");
        }
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this.cancelled) {
                return undefined;
            }

            const headers: Record<string, string> = {};
            if (this.etag) {
                headers["if-none-match"] = this.etag;
            }

            logger.info(`=> GET ${this.url} if-none-match: ${this.etag}`);
            const poll = await this.fetch(this.url, { method: "GET", headers });

            if (poll.status === 404) {
                this.cancel(RendezvousFailureReason.Unknown);
                return undefined;
            }

            // rely on server expiring the channel rather than checking ourselves

            if (poll.headers.get("content-type") !== "text/plain") {
                this.etag = poll.headers.get("etag") ?? undefined;
            } else if (poll.status === 200) {
                this.etag = poll.headers.get("etag") ?? undefined;
                const text = await poll.text();
                logger.info(`Received: ${text} with etag ${this.etag}`);
                return text;
            }
            await sleep(1000);
        }
    }

    public async cancel(reason: RendezvousFailureReason): Promise<void> {
        if (reason === RendezvousFailureReason.Unknown && this.expiresAt && this.expiresAt.getTime() < Date.now()) {
            reason = RendezvousFailureReason.Expired;
        }

        this.cancelled = true;
        this._ready = false;
        this.onFailure?.(reason);

        if (this.url && reason === RendezvousFailureReason.UserDeclined) {
            try {
                await this.fetch(this.url, { method: "DELETE" });
            } catch (e) {
                logger.warn(e);
            }
        }
    }
}
