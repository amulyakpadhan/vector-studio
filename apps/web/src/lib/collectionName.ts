import type { DbEngine } from "@vyn/core";

export interface NameCheck {
  /** Name to actually send to the engine — may differ from the input (Weaviate auto-capitalizes). */
  value: string;
  /** Set when the name is invalid (even after normalization) — submit should be blocked. */
  error?: string;
  /** Set when normalization silently changed the name, so the UI can show what will actually be created. */
  note?: string;
}

const QDRANT_INVALID_CHARS = ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\0', '\x1F'];

/**
 * Each engine rejects (or silently rewrites) collection names differently — verified against
 * each project's own validation source rather than guessed:
 *   - Pinecone:  lowercase alphanumeric + hyphen only (its own /indexes 400 error).
 *   - Weaviate:  must start with an uppercase letter, then letters/digits/underscores (server
 *     regex `[A-Z][_0-9A-Za-z]{0,254}`); its official clients auto-capitalize the first letter
 *     before sending, so we do the same instead of just erroring.
 *   - Milvus:    must start with a letter or underscore, then letters/digits/underscores.
 *   - Chroma:    3-63 chars, starts/ends alphanumeric, no "..", not a bare IPv4 address
 *     ("mimics s3 bucket requirements" per its own source comment).
 *   - Qdrant:    only rejects filesystem-unsafe characters; otherwise unrestricted.
 */
export function checkCollectionName(engine: DbEngine, raw: string): NameCheck {
  const name = raw.trim();
  if (!name) return { value: name, error: "Name is required." };

  switch (engine) {
    case "pinecone":
      if (!/^[a-z0-9-]+$/.test(name)) {
        return { value: name, error: 'Pinecone index names must be lowercase alphanumeric characters or "-".' };
      }
      return { value: name };

    case "weaviate": {
      const first = name[0]!;
      if (!/[A-Za-z]/.test(first)) {
        return { value: name, error: "Weaviate collection names must start with a letter." };
      }
      const capitalized = first.toUpperCase() + name.slice(1);
      if (!/^[A-Z][A-Za-z0-9_]{0,254}$/.test(capitalized)) {
        return { value: capitalized, error: "Weaviate collection names may only contain letters, numbers and underscores." };
      }
      return capitalized !== name
        ? { value: capitalized, note: `Weaviate requires an initial capital — will be created as "${capitalized}".` }
        : { value: capitalized };
    }

    case "milvus":
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return {
          value: name,
          error: "Milvus collection names must start with a letter or underscore, and contain only letters, numbers and underscores.",
        };
      }
      return { value: name };

    case "chroma": {
      const shapeOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/.test(name);
      const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
      if (name.length < 3 || name.length > 63 || !shapeOk || name.includes("..") || isIpv4) {
        return {
          value: name,
          error:
            "Chroma collection names need 3-63 characters, must start and end with a letter or number, and can't look like an IP address.",
        };
      }
      return { value: name };
    }

    case "qdrant": {
      const bad = QDRANT_INVALID_CHARS.find((c) => name.includes(c));
      if (bad) return { value: name, error: `Qdrant collection names can't contain "${bad === "\0" ? "\\0" : bad}".` };
      return { value: name };
    }

    default:
      return { value: name };
  }
}
