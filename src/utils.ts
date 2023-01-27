import { isErrorOfMissingDoc } from "./utils_couchdb";

export function resolveWithIgnoreKnownError<T>(p: Promise<T>, def: T): Promise<T> {
    return new Promise((res, rej) => {
        p.then(res).catch((ex) => (isErrorOfMissingDoc(ex) ? res(def) : rej(ex)));
    });
}

// time util
export const delay = (ms: number): Promise<void> => {
    return new Promise((res) => {
        setTimeout(() => {
            res();
        }, ms);
    });
};

// Referenced below
// https://zenn.dev/sora_kumo/articles/539d7f6e7f3c63
export const Parallels = (ps = new Set<Promise<unknown>>()) => ({
    add: (p: Promise<unknown>) => ps.add(!!p.then(() => ps.delete(p)).catch(() => ps.delete(p)) && p),
    wait: (limit: number) => ps.size >= limit && Promise.race(ps),
    all: () => Promise.all(ps),
});
export async function allSettledWithConcurrencyLimit<T>(processes: Promise<T>[], limit: number) {
    const ps = Parallels();
    for (const proc of processes) {
        ps.add(proc);
        await ps.wait(limit);
    }
    (await ps.all()).forEach(() => { });
}



export function getDocData(doc: string | string[]) {
    return typeof (doc) == "string" ? doc : doc.join("")
}
export function getDocDataAsArray(doc: string | string[]) {
    return typeof (doc) == "string" ? [doc] : doc
}
const chunkCheckLen = 1000000;
function stringYielder(src: string[]) {
    return (function* gen() {
        let buf = "";
        for (const piece of src) {
            buf += piece;
            while (buf.length > chunkCheckLen) {
                const p = buf.slice(0, chunkCheckLen);
                buf = buf.substring(chunkCheckLen);
                yield p;
            }
        }
        if (buf != "") yield buf;
        return;
    })();

}
export function isDocContentSame(docA: string | string[], docB: string | string[]) {
    const docAArray = getDocDataAsArray(docA);
    const docBArray = getDocDataAsArray(docB);
    const chunkA = stringYielder(docAArray);
    const chunkB = stringYielder(docBArray);

    let genA;
    let genB;
    do {
        genA = chunkA.next();
        genB = chunkB.next();
        if (genA.value != genB.value) {
            return false;
        }
        if (genA.done != genB.done) {
            return false;
        }
    } while (!genA.done)

    if (!genB.done) return false;
    return true;
}