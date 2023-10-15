import { slug as slugger } from "github-slugger";
import type { ReadFrontmatter } from "@content/_schemas";

export const rslugifyStr = (str: string) => slugger(str);

const rslugify = (reads: ReadFrontmatter) =>
  reads.readSlug ? slugger(reads.readSlug) : slugger(reads.title);

export const rslugifyAll = (arr: string[]) => arr.map(str => rslugifyStr(str));

export default rslugify;
