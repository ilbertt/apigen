import type { ForeignKey, OpenApiOptions, RelationColumns, SchemaState } from './contract.js';

type JsonObject = Record<string, unknown>;

const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint']);
const NUMBER_TYPES = new Set([
  'numeric',
  'decimal',
  'float4',
  'float8',
  'real',
  'double precision',
]);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);

/** Map a Postgres type to a Swagger `{ type, format }`; `format` keeps the pg type verbatim. */
function swaggerType(pgType: string): { type: string; format: string } {
  if (INTEGER_TYPES.has(pgType)) {
    return { type: 'integer', format: pgType };
  }
  if (NUMBER_TYPES.has(pgType)) {
    return { type: 'number', format: pgType };
  }
  if (BOOLEAN_TYPES.has(pgType)) {
    return { type: 'boolean', format: pgType };
  }
  return { type: 'string', format: pgType };
}

/** The PostgREST-style `Note:` annotating a column's PK/FK role, or undefined if plain. */
function columnNote({
  isPrimaryKey,
  foreignKey,
}: {
  isPrimaryKey: boolean;
  foreignKey?: { relation: string; column: string };
}): string | undefined {
  const notes: string[] = [];
  if (isPrimaryKey) {
    notes.push('This is a Primary Key.<pk/>');
  }
  if (foreignKey !== undefined) {
    notes.push(
      `This is a Foreign Key to \`${foreignKey.relation}.${foreignKey.column}\`.<fk table='${foreignKey.relation}' column='${foreignKey.column}'/>`,
    );
  }
  return notes.length > 0 ? `Note:\n${notes.join('\n')}` : undefined;
}

/** Index each FK-constrained column to the (relation, column) it references. */
function foreignKeysByColumn(
  foreignKeys: readonly ForeignKey[],
): Map<string, { relation: string; column: string }> {
  const byColumn = new Map<string, { relation: string; column: string }>();
  for (const fk of foreignKeys) {
    for (let i = 0; i < fk.columns.length; i += 1) {
      const local = fk.columns[i];
      const foreign = fk.foreignColumns[i];
      if (local !== undefined && foreign !== undefined) {
        byColumn.set(local, { relation: fk.foreignRelation, column: foreign });
      }
    }
  }
  return byColumn;
}

function definitionFor({
  columns,
  primaryKey,
  foreignKeys,
}: {
  columns: RelationColumns;
  primaryKey: readonly string[];
  foreignKeys: readonly ForeignKey[];
}): JsonObject {
  const pkColumns = new Set(primaryKey);
  const fkByColumn = foreignKeysByColumn(foreignKeys);
  const properties: JsonObject = {};
  for (const [column, pgType] of Object.entries(columns)) {
    const note = columnNote({
      isPrimaryKey: pkColumns.has(column),
      foreignKey: fkByColumn.get(column),
    });
    properties[column] = {
      ...(note !== undefined && { description: note }),
      ...swaggerType(pgType),
    };
  }
  return { properties };
}

const ref = (name: string): JsonObject => ({ $ref: `#/parameters/${name}` });

/** The request context needed to fill request-specific document fields. */
export interface OpenApiRequest {
  host: string;
  scheme: string;
  schema: string;
}

/**
 * Build apigen's OpenAPI (Swagger 2.0) document for one schema — the relations mounted
 * on it, the operations each exposes, and their column definitions. Modeled on
 * PostgREST's shape (so PostgREST-aware tooling recognizes it) but carrying apigen's own
 * identity. Served at `GET /openapi`.
 */
export function buildOpenApiDocument({
  state,
  request,
  options,
}: {
  state: SchemaState;
  request: OpenApiRequest;
  options: OpenApiOptions;
}): JsonObject {
  const info: JsonObject = {
    description: options.description ?? '',
    title: options.title ?? `apigen (${request.schema} schema)`,
  };
  // `version` is required by Swagger but we omit it unless the caller supplies one —
  // apigen can't reliably know its own version at runtime.
  if (options.version !== undefined) {
    info.version = options.version;
  }
  const paths: JsonObject = {};
  const definitions: JsonObject = {};
  const parameters: JsonObject = {
    select: {
      name: 'select',
      description: 'Filtering Columns',
      required: false,
      in: 'query',
      type: 'string',
    },
    order: { name: 'order', description: 'Ordering', required: false, in: 'query', type: 'string' },
    on_conflict: {
      name: 'on_conflict',
      description: 'On Conflict',
      required: false,
      in: 'query',
      type: 'string',
    },
    range: {
      name: 'Range',
      description: 'Limiting and Pagination',
      required: false,
      in: 'header',
      type: 'string',
    },
    rangeUnit: {
      name: 'Range-Unit',
      description: 'Limiting and Pagination',
      required: false,
      default: 'items',
      in: 'header',
      type: 'string',
    },
    offset: {
      name: 'offset',
      description: 'Limiting and Pagination',
      required: false,
      in: 'query',
      type: 'string',
    },
    limit: {
      name: 'limit',
      description: 'Limiting and Pagination',
      required: false,
      in: 'query',
      type: 'string',
    },
    preferCount: {
      name: 'Prefer',
      description: 'Preference',
      required: false,
      enum: ['count=exact'],
      in: 'header',
      type: 'string',
    },
    preferReturn: {
      name: 'Prefer',
      description: 'Preference',
      required: false,
      enum: ['return=representation', 'return=minimal', 'return=headers-only'],
      in: 'header',
      type: 'string',
    },
    preferPost: {
      name: 'Prefer',
      description: 'Preference',
      required: false,
      enum: [
        'return=representation',
        'return=minimal',
        'return=headers-only',
        'resolution=merge-duplicates',
        'resolution=ignore-duplicates',
        'missing=default',
      ],
      in: 'header',
      type: 'string',
    },
  };

  for (const name of [...state.modules.keys()].sort()) {
    const module = state.modules.get(name);
    const columns = state.catalog[name];
    if (module === undefined || columns === undefined) {
      continue;
    }
    const columnNames = Object.keys(columns);
    definitions[name] = definitionFor({
      columns,
      primaryKey: state.primaryKeys[name] ?? [],
      foreignKeys: state.foreignKeys[name] ?? [],
    });
    parameters[`body.${name}`] = {
      name,
      description: name,
      required: false,
      in: 'body',
      schema: { $ref: `#/definitions/${name}` },
    };
    const rowFilters = columnNames.map((column) => {
      parameters[`rowFilter.${name}.${column}`] = {
        name: column,
        required: false,
        in: 'query',
        type: 'string',
      };
      return ref(`rowFilter.${name}.${column}`);
    });

    const path: JsonObject = {};
    if (module.handlers.select !== undefined) {
      path.get = {
        tags: [name],
        parameters: [
          ...rowFilters,
          ref('select'),
          ref('order'),
          ref('range'),
          ref('rangeUnit'),
          ref('offset'),
          ref('limit'),
          ref('preferCount'),
        ],
        responses: {
          '200': {
            description: 'OK',
            schema: { type: 'array', items: { $ref: `#/definitions/${name}` } },
          },
        },
      };
    }
    if (module.handlers.insert !== undefined) {
      path.post = {
        tags: [name],
        parameters: [ref(`body.${name}`), ref('select'), ref('on_conflict'), ref('preferPost')],
        responses: { '201': { description: 'Created' } },
      };
    }
    if (module.handlers.update !== undefined) {
      path.patch = {
        tags: [name],
        parameters: [...rowFilters, ref(`body.${name}`), ref('select'), ref('preferReturn')],
        responses: { '200': { description: 'OK' }, '204': { description: 'No Content' } },
      };
    }
    if (module.handlers.delete !== undefined) {
      path.delete = {
        tags: [name],
        parameters: [...rowFilters, ref('preferReturn')],
        responses: { '204': { description: 'No Content' } },
      };
    }
    paths[`/${name}`] = path;
  }

  return {
    swagger: '2.0',
    info,
    host: request.host,
    basePath: '/',
    schemes: [request.scheme],
    consumes: ['application/json', 'application/vnd.pgrst.object+json', 'text/csv'],
    produces: ['application/json', 'application/vnd.pgrst.object+json', 'text/csv'],
    paths,
    definitions,
    parameters,
    externalDocs: {
      description: 'apigen',
      url: 'https://github.com/ilbertt/apigen',
    },
  };
}
