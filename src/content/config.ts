import { defineCollection } from "astro:content";
import { blogSchema } from "./_schemas";

const blog = defineCollection({
  schema: blogSchema,
});
const reads = defineCollection({
  schema: blogSchema,
});

export const collections = { blog, reads };
