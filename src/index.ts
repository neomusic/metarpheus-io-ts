import * as gen from 'io-ts-codegen';
import lowerFirst = require('lodash/lowerFirst');
import { Reader, reader, ask } from 'fp-ts/lib/Reader';
import { array, compact, sort } from 'fp-ts/lib/Array';
import {
  Tpe,
  Model,
  CaseClassMember,
  Enum,
  CaseClass,
  Route,
  RouteSegment,
  RouteSegmentString,
  RouteSegmentParam,
  TaggedUnion,
  TaggedUnionValue
} from './domain';
import { contramap, ordString } from 'fp-ts/lib/Ord';
import { Option, none, some } from 'fp-ts/lib/Option';

interface Ctx {
  models: Array<Model>;
  prefix: string;
  useLegacyNewtype: boolean;
}

function isNewtype(tpe: Tpe): Reader<Ctx, boolean> {
  return ask<Ctx>().map(({ models }) => models.some(m => m.name === tpe.name && 'isValueClass' in m && m.isValueClass));
}

const traverseReader = array.traverse(reader);

function genericCombinator(tpe: Tpe): Reader<Ctx, gen.CustomCombinator> {
  return ask<Ctx>().chain(({ prefix }) => {
    const type = gen.identifier(`${prefix}${tpe.name}`);
    const staticArgsR = traverseReader(tpe.args!, t => getType(t)).map(typeReferences =>
      typeReferences.map(gen.printStatic)
    );
    const runtimeArgsR = traverseReader(tpe.args!, t => getType(t)).map(typeReferences =>
      typeReferences.map(gen.printRuntime).join(', ')
    );
    return staticArgsR.chain(staticArgs =>
      runtimeArgsR.chain(runtimeArgs =>
        isNewtype(tpe).map(newtype =>
          gen.customCombinator(
            `${gen.printStatic(type)}<${staticArgs.join(', ')}>`,
            newtype
              ? `${gen.printRuntime(type)}<${staticArgs.map(C => `t.TypeOf<typeof ${C}>`).join(', ')}>()`
              : `${gen.printRuntime(type)}(${runtimeArgs})`,
            gen.getNodeDependencies(type)
          )
        )
      )
    );
  });
}

function optionCombinator(tpe: Tpe): Reader<Ctx, gen.CustomCombinator> {
  return getType(tpe.args![0]).map(t =>
    gen.customCombinator(
      `Option<${gen.printStatic(t)}>`,
      `createOptionFromNullable(${gen.printRuntime(t)})`,
      gen.getNodeDependencies(t)
    )
  );
}

export function getType(tpe: Tpe): Reader<Ctx, gen.TypeReference> {
  return ask<Ctx>().chain<gen.TypeReference>(({ prefix }) => {
    switch (tpe.name) {
      case 'String':
        return reader.of(gen.stringType);
      case 'Int':
      case 'Long':
        return reader.of(gen.integerType);
      case 'Float':
      case 'Double':
      case 'BigDecimal':
        return reader.of(gen.numberType);
      case 'Boolean':
        return reader.of(gen.booleanType);
      case 'Any':
        return reader.of(gen.unknownType);
      case 'Unit':
        return reader.of(gen.customCombinator('void', `${prefix}VoidFromUnit`));
      case 'Option':
        return optionCombinator(tpe);
      case 'List':
      case 'Set':
      case 'TreeSet':
        return getType(tpe.args![0]).map(gen.arrayCombinator);
      case 'Map':
        return getType(tpe.args![0]).chain(keyType =>
          getType(tpe.args![1]).chain(valueType => partialRecordCombinator(keyType, valueType))
        );
      default:
        if (tpe.args && tpe.args.length > 0) {
          return genericCombinator(tpe);
        }
        return reader.of(gen.identifier(`${prefix}${tpe.name}`));
    }
  });
}

function partialRecordCombinator(
  keyType: gen.TypeReference,
  valueType: gen.TypeReference
): Reader<Ctx, gen.Combinator> {
  return ask<Ctx>().map(({ models }) => {
    const model = models.find(m => keyType.kind === 'Identifier' && m.name === keyType.name);
    if (model && model._type === 'CaseEnum') {
      return gen.partialCombinator(model.values.map(k => gen.property(k.name, valueType)));
    }
    return gen.recordCombinator(keyType, valueType);
  });
}

export interface GetModelsOptions {
  runtime: boolean;
  useLegacyNewtype?: boolean;
}

function getProperty(member: CaseClassMember): Reader<Ctx, gen.Property> {
  return getType(member.tpe).map(type => gen.property(member.name, type, false, member.desc));
}

function getNewtype(model: CaseClass): Reader<Ctx, gen.CustomTypeDeclaration> {
  return ask<Ctx>().chain(({ useLegacyNewtype }) => {
    return getType(model.members[0].tpe).map(tsType => {
      const staticType = gen.printStatic(tsType);
      const runtimeType = gen.printRuntime(tsType);
      const hasTypeParams = model.typeParams && model.typeParams.length > 0;
      const typeParams = hasTypeParams ? `<${model.typeParams.map(t => `${t.name}`).join(', ')}>` : '';
      const dependencies = gen.getNodeDependencies(tsType);
      const newtypeSymbol = `readonly ${model.name}: unique symbol`;
      const legacyNewtypeSymbol = `readonly ${model.name}: '${model.name}'`;
      const readonlyTypeParams = () =>
        model.typeParams.map(t => `readonly ${model.name}_${t.name}: ${t.name}`).join(', ');
      const staticRepr = hasTypeParams
        ? `export interface ${model.name}${typeParams} extends Newtype<{ ${
            useLegacyNewtype ? legacyNewtypeSymbol : newtypeSymbol
          }, ${readonlyTypeParams()} }, ${staticType}> {}`
        : `export interface ${model.name}${typeParams} extends Newtype<{ ${
            useLegacyNewtype ? legacyNewtypeSymbol : newtypeSymbol
          } }, ${staticType}> {}`;
      const runtimeRepr = hasTypeParams
        ? [
            `export function ${model.name}${typeParams}() { return fromNewtype<${model.name}${typeParams}>()(${runtimeType}) }`,
            `export function ${lowerFirst(model.name)}Iso${typeParams}() { return iso<${model.name}${typeParams}>() }`
          ].join('\n')
        : [
            `export const ${model.name} = fromNewtype<${model.name}>()(${runtimeType});`,
            `export const ${lowerFirst(model.name)}Iso = iso<${model.name}>();`
          ].join('\n');

      return gen.customTypeDeclaration(model.name, staticRepr, runtimeRepr, dependencies);
    });
  });
}

function getCaseClassDeclaration(caseClass: CaseClass): Reader<Ctx, gen.TypeDeclaration | gen.CustomTypeDeclaration> {
  if (caseClass.isValueClass) {
    return getNewtype(caseClass);
  }
  return traverseReader(caseClass.members, getProperty).map(properties => {
    const interfaceDecl = gen.typeCombinator(properties, caseClass.name);
    if (caseClass.typeParams && caseClass.typeParams.length > 0) {
      const staticParams = caseClass.typeParams.map(p => `${p.name} extends t.Mixed`).join(', ');
      const runtimeParams = caseClass.typeParams.map(p => `${p.name}: ${p.name}`).join(', ');
      const dependencies = interfaceDecl.properties
        .map(p => gen.printStatic(p.type))
        .filter(p => !caseClass.typeParams.map(p => p.name).includes(p));
      return gen.customTypeDeclaration(
        caseClass.name,
        `export interface ${caseClass.name}<${caseClass.typeParams.map(p => p.name)}> ${gen.printStatic(
          interfaceDecl
        )}`,
        `export const ${caseClass.name} = <${staticParams}>(${runtimeParams}) => ${gen.printRuntime(interfaceDecl)}`,
        dependencies
      );
    } else {
      return gen.typeDeclaration(caseClass.name, interfaceDecl, true, false);
    }
  });
}

function getEnumDeclaration(enumModel: Enum): Reader<Ctx, gen.TypeDeclaration | gen.CustomTypeDeclaration> {
  return reader.of(
    gen.typeDeclaration(
      enumModel.name,
      gen.keyofCombinator(
        enumModel.values.map(v => v.name),
        enumModel.name
      ),
      true,
      false
    )
  );
}

function getTaggedUnionDeclaration(taggedUnion: TaggedUnion): Reader<Ctx, Option<gen.TypeDeclaration>> {
  const getTaggedUnionValue = (v: TaggedUnionValue): Reader<Ctx, gen.TypeReference> =>
    traverseReader(v.params, getProperty).map(properties =>
      gen.typeCombinator(properties.concat(gen.property('_type', gen.literalCombinator(v.name))), v.name)
    );
  const toTypeDeclaration = (values: gen.TypeReference[]): Option<gen.TypeDeclaration> =>
    values.length === 0
      ? none
      : some(
          values.length === 1
            ? gen.typeDeclaration(taggedUnion.name, values[0], true, false)
            : gen.typeDeclaration(taggedUnion.name, gen.unionCombinator(values, taggedUnion.name), true, false)
        );
  return traverseReader(taggedUnion.values, getTaggedUnionValue).map(toTypeDeclaration);
}

function getDeclarations(models: Array<Model>): Reader<Ctx, Array<gen.TypeDeclaration | gen.CustomTypeDeclaration>> {
  return traverseReader(models, model => {
    switch (model._type) {
      case 'CaseClass':
        return getCaseClassDeclaration(model).map(some);
      case 'CaseEnum':
        return getEnumDeclaration(model).map(some);
      case 'TaggedUnion':
        return getTaggedUnionDeclaration(model);
    }
  }).map(compact);
}

const newtypePrelude = `
interface Newtype<URI, A> {
  _URI: URI
  _A: A
}
interface Iso<S, A> {
  unwrap: (s: S) => A
  wrap: (a: A) => S
}
const unsafeCoerce = <A, B>(a: A): B => a as any
type Carrier<N extends Newtype<any, any>> = N['_A']
type AnyNewtype = Newtype<any, any>
const fromNewtype = <N extends AnyNewtype>() => <O>(type: t.Type<Carrier<N>, O>): t.Type<N, O> =>
  type as any
const iso = <S extends AnyNewtype>(): Iso<S, Carrier<S>> =>
  ({ wrap: unsafeCoerce, unwrap: unsafeCoerce })

`;

const unitPrelude = `export const VoidFromUnit = new t.Type<void, {}>(
  'VoidFromUnit',
  (_m): _m is void => true,
  () => t.success(undefined),
  () => ({})
)
`;

const ordDeclarations = contramap((d: gen.TypeDeclaration | gen.CustomTypeDeclaration) => d.name, ordString);
const sortDeclarations = sort(ordDeclarations);

export function getModels(models: Array<Model>, options: GetModelsOptions, prelude: string = ''): string {
  const declarations = getDeclarations(models).run({
    models,
    prefix: '',
    useLegacyNewtype: options.useLegacyNewtype || false
  });
  const hasNewtypeDeclarations = models.some(m => 'isValueClass' in m && m.isValueClass);
  const sortedTypeDeclarations = gen.sort(sortDeclarations(declarations));
  let out = [
    '// DO NOT EDIT MANUALLY - metarpheus-generated',
    "import * as t from 'io-ts'",
    '// @ts-ignore',
    "import { createOptionFromNullable } from 'io-ts-types/lib/fp-ts/createOptionFromNullable'",
    '// @ts-ignore',
    "import { Option } from 'fp-ts/lib/Option'",
    '',
    ''
  ].join('\n');
  if (hasNewtypeDeclarations) {
    out += newtypePrelude;
  }
  if (options.runtime) {
    out += prelude;
    out += unitPrelude;
  }
  out += sortedTypeDeclarations
    .map(d => {
      return options.runtime ? gen.printStatic(d) + '\n\n' + gen.printRuntime(d) : gen.printStatic(d);
    })
    .join('\n\n');
  return out;
}

function isRouteSegmentString(routeSegment: RouteSegment): routeSegment is RouteSegmentString {
  return routeSegment.hasOwnProperty('str');
}

function isRouteSegmentParam(routeSegment: RouteSegment): routeSegment is RouteSegmentParam {
  return routeSegment.hasOwnProperty('routeParam');
}

function getRoutePath(route: Route): string {
  const path = route.route
    .map(routeSegment => {
      if (isRouteSegmentString(routeSegment)) {
        return routeSegment.str;
      }
      if (isRouteSegmentParam(routeSegment)) {
        return '${' + routeSegment.routeParam.name + '}';
      }
    })
    .join('/');
  return '`${_metarpheusRouteConfig.apiEndpoint}/' + path + '`';
}

function getRouteParams(route: Route): Reader<Ctx, string> {
  const routeParams = route.params.filter(param => !param.inBody);
  return traverseReader(routeParams, param =>
    getType(param.tpe).map(type => {
      const paramTpe = param.required ? type : gen.unionCombinator([type, gen.undefinedType]);
      return `          ${param.name}: ${gen.printRuntime(paramTpe)}.encode(${param.name})`;
    })
  ).map(params => {
    return `{\n${params.join(',\n')}\n        }`;
  });
}

function getRouteData(route: Route): Reader<Ctx, string> {
  if (route.method === 'post' && route.body) {
    // the name `data` is hardcoded for this param in `getRouteArguments`
    return getType(route.body.tpe).map(type => `${gen.printRuntime(type)}.encode(data)`);
  }

  const routeParams = route.params.filter(param => param.inBody);
  return traverseReader(routeParams, param =>
    getType(param.tpe).map(type => {
      const paramTpe = param.required ? type : gen.unionCombinator([type, gen.undefinedType]);
      return `          ${param.name}: ${gen.printRuntime(paramTpe)}.encode(${param.name})`;
    })
  ).map(params => {
    return `{\n${params.join(',\n')}\n        }`;
  });
}

function getRouteHeaders(route: Route): string {
  const headers = [{ name: `'Content-Type'`, value: `'application/json'` }];
  if (route.method === 'get') {
    headers.push({ name: `'Pragma'`, value: `'no-cache'` });
    headers.push({ name: `'Cache-Control'`, value: `'no-cache, no-store'` });
  }
  if (route.authenticated) {
    headers.push({ name: `'Authorization'`, value: '`Token token="${token}"`' });
  }
  let s = '{\n';
  s += headers
    .map(header => {
      return `          ${header.name}: ${header.value}`;
    })
    .join(',\n');
  s += '\n        }';
  return s;
}

function getAxiosConfig(route: Route): Reader<Ctx, string> {
  return getRouteParams(route).chain(routeParams =>
    getRouteData(route).map(routeData => {
      let s = '{';
      s += `\n        method: '${route.method}',`;
      s += `\n        url: ${getRoutePath(route)},`;
      s += `\n        params: ${routeParams},`;
      s += `\n        data: ${routeData},`;
      s += `\n        headers: ${getRouteHeaders(route)},`;
      s += '\n        timeout: _metarpheusRouteConfig.timeout';
      s += '\n      }';
      return s;
    })
  );
}

function getRouteArguments(route: Route): Reader<Ctx, string> {
  const paramsR = [
    ...route.params,
    ...route.route
      .filter(isRouteSegmentParam)
      .map(({ routeParam }, index) => ({ ...routeParam, name: routeParam.name || `param${index + 1}` }))
  ];
  return traverseReader(paramsR, param =>
    getType(param.tpe).map(type => {
      const tpe = param.required ? type : gen.unionCombinator([type, gen.undefinedType]);
      return {
        name: param.name,
        type: gen.printStatic(tpe)
      };
    })
  ).chain(params =>
    getParamsToPrint(route, params).map(paramsToPrint => {
      return `{ ${paramsToPrint.map(param => param.name).join(', ')} }: { ${paramsToPrint
        .map(param => `${param.name}: ${param.type}`)
        .join(', ')} }`;
    })
  );
}

interface Param {
  name: string | undefined;
  type: string;
}

function getParamsToPrint(route: Route, params: Array<Param>): Reader<Ctx, Array<Param>> {
  const p1 = route.authenticated ? [{ name: 'token', type: 'string' }, ...params] : params;
  return route.method === 'post' && route.body
    ? getType(route.body.tpe).map(bodyType =>
        // the name `data` for this param is hardcoded in `getRouteData`
        [...p1, { name: 'data', type: gen.printStatic(bodyType) }]
      )
    : reader.of(p1);
}

function getRoute(_route: Route): Reader<Ctx, string> {
  const segments = _route.route.reduce(
    (acc, s: RouteSegment) => {
      return isRouteSegmentParam(s)
        ? {
            counter: acc.counter + 1,
            segments: [
              ...acc.segments,
              { ...s, routeParam: { ...s.routeParam, name: s.routeParam.name || `param${acc.counter}` } }
            ]
          }
        : { counter: acc.counter, segments: [...acc.segments, s] };
    },
    { counter: 1, segments: [] as RouteSegment[] }
  ).segments;

  const route = { ..._route, route: segments };
  const name = route.name.join('_');
  return ask<Ctx>().chain(() =>
    getType(route.returns).chain(returns =>
      getAxiosConfig(route).chain(axiosConfig =>
        getRouteArguments(route).map(routeArguments => {
          const docs = route.desc ? `    /** ${route.desc} */\n` : '';
          return [
            `${docs}    ${name}: function (${routeArguments}): TaskEither<unknown, ${gen.printStatic(returns)}> {`,
            `      return tryCatch(() => axios(${axiosConfig}), identity).chain(res =>
              fromEither(${gen.printRuntime(returns)}.decode(res.data))
            )`,
            '    }'
          ].join('\n');
        })
      )
    )
  );
}

const getRoutesPrelude = `// DO NOT EDIT MANUALLY - metarpheus-generated
import axios from 'axios'
import { tryCatch, TaskEither, fromEither } from 'fp-ts/lib/TaskEither'
import { identity } from 'fp-ts/lib/function'
import * as t from 'io-ts'
// @ts-ignore
import { createOptionFromNullable } from 'io-ts-types/lib/fp-ts/createOptionFromNullable'
// @ts-ignore
import { Option } from 'fp-ts/lib/Option'
import * as m from './model-ts'

export interface RouteConfig {
  apiEndpoint: string,
  timeout: number
}
`;

export function getRoutes(routes: Array<Route>, models: Array<Model>, prelude: string = getRoutesPrelude): string {
  return (
    prelude +
    `
export default function getRoutes(_metarpheusRouteConfig: RouteConfig) {
  return {
` +
    routes.map(route => getRoute(route).run({ models, prefix: 'm.', useLegacyNewtype: false })).join(',\n\n') +
    `
  }
}`
  );
}
