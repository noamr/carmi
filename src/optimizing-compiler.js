const { Expr, Token, Setter, Expression, SetterExpression, SpliceSetterExpression, TokenTypeData } = require('./lang');
const _ = require('lodash');
const NaiveCompiler = require('./naive-compiler');
const fs = require('fs');
const {
  tagExprWithPaths,
  findReferencesToPathInAllGetters,
  splitSettersGetters,
  pathMatches,
  pathFragmentToString,
  normalizeAndTagAllGetters,
  allPathsInGetter
} = require('./expr-tagging');

class OptimizingCompiler extends NaiveCompiler {
  constructor(model, name) {
    const { getters, setters } = splitSettersGetters(model);
    super({ ...model, ...normalizeAndTagAllGetters(getters, setters) }, name);
  }

  get template() {
    return require('./templates/optimizing.js');
  }

  byTokenTypesPlaceHolders(expr) {
    const currentToken = expr instanceof Expression ? expr[0] : expr;
    const tokenType = currentToken.$type;
    switch (tokenType) {
      case 'object':
        return {
          ARGS: () => {
            return _.range(1, expr.length, 2)
              .map(i => `'${expr[i]}'`)
              .join(',');
          }
        };
      case 'array':
        return {
          ARGS: () => expr.length - 1
        };
    }
    return {};
  }

  exprTemplatePlaceholders(expr, funcName) {
    const currentToken = expr instanceof Expression ? expr[0] : expr;
    const tokenType = currentToken.$type;
    return Object.assign(
      {
        TRACKING: () => this.tracking(expr),
        PRETRACKING: () => {
          if (expr[0].$path) {
            return Array.from(expr[0].$path.values())
              .filter(cond => cond)
              .map(cond => `let $cond_${cond} = false;`)
              .join('');
          }
          return '';
        },
        INVALIDATES: () => (tag, content) => {
          return this.invalidates(this.pathOfExpr(expr)) ? content : '';
        }
      },
      this.byTokenTypesPlaceHolders(expr),
      super.exprTemplatePlaceholders(expr, funcName)
    );
  }

  generateExpr(expr) {
    const currentToken = expr instanceof Expression ? expr[0] : expr;
    const tokenType = currentToken.$type;
    switch (tokenType) {
      case 'get':
        if (expr[0].$conditional && expr[0].$rootName) {
          const getter = this.getters[expr[0].$rootName];
          const paths = allPathsInGetter(getter);
          if (Array.from(paths.values()).filter(k => k === expr[0].$id).length) {
            return `${this.generateExpr(expr[2])}[($cond_${expr[0].$id} = true && ${this.generateExpr(expr[1])})]`;
          }
        }
        return super.generateExpr(expr);
      case 'object':
      case 'array':
        return `${tokenType}($invalidatedKeys,key,${super.generateExpr(expr)}, ${tokenType}$${
          expr[0].$id
        }Token, ${tokenType}$${expr[0].$id}Args, ${this.invalidates(this.pathOfExpr(expr))})`;
      case 'keys':
      case 'values':
        return `valuesOrKeysForObject(acc, key, getUniquePersistenObject(${expr[0].$id}), ${this.generateExpr(
          expr[1]
        )}, ${tokenType === 'values' ? 'true' : 'false'})`;
      case 'size':
        return `size(acc, key, ${this.generateExpr(expr[1])}, getUniquePersistenObject(${expr[0].$id}))`;
      case 'assign':
      case 'defaults':
        return `assignOrDefaults(acc, key, getUniquePersistenObject(${expr[0].$id}), ${this.generateExpr(expr[1])}, ${
          tokenType === 'assign' ? 'true' : 'false'
        })`;
      case 'range':
        return `range(acc, key, ${this.generateExpr(expr[1])}, ${expr.length > 2 ? this.generateExpr(expr[2]) : '0'}, ${
          expr.length > 2 ? this.generateExpr(expr[2]) : '1'
        }, getUniquePersistenObject(${expr[0].$id}))`;
      case 'map':
      case 'any':
      case 'mapValues':
      case 'anyValues':
      case 'recursiveMap':
      case 'recursiveMapValues':
      case 'filterBy':
      case 'groupBy':
      case 'keyBy':
      case 'filter':
      case 'mapKeys':
        return `${
          this.template[tokenType].collectionFunc
            ? this.template[tokenType].collectionFunc
            : TokenTypeData[tokenType].arrayVerb
              ? 'forArray'
              : 'forObject'
        }(acc, key, ${this.generateExpr(expr[1])}, ${this.generateExpr(expr[2])}, ${
          typeof expr[3] === 'undefined' ? null : this.generateExpr(expr[3])
        })`;
      case 'topLevel':
        return `$res`;
      case 'wildcard':
        return '$wildcard';
      case 'recur':
        return `${this.generateExpr(expr[1])}.recursiveSteps(${this.generateExpr(expr[2])}, $invalidatedKeys, key)`;
      default:
        return super.generateExpr(expr);
    }
  }

  buildDerived(name) {
    return `$invalidatedRoots.has('${name}') && $${name}Build();`;
  }

  buildExprFunctionsByTokenType(acc, expr) {
    const tokenType = expr[0].$type;
    switch (tokenType) {
      case 'object':
      case 'array':
        this.appendExpr(acc, tokenType, expr, `${tokenType}$${expr[0].$id}`);
        break;
      default:
        super.buildExprFunctionsByTokenType(acc, expr);
    }
  }

  buildSetter(setterExpr, name) {
    const args = setterExpr
      .slice(1)
      .filter(t => typeof t !== 'string' && typeof t !== 'number')
      .map(t => t.$type);
    const taint = new Array(setterExpr.length - 1)
      .fill()
      .map((v, idx) => `$tainted.add(${this.pathToString(setterExpr, idx + 1)});`)
      .join('');
    const invalidate = new Array(setterExpr.length - 1)
      .fill()
      .map(
        (v, idx) =>
          `triggerInvalidations(${this.pathToString(setterExpr, idx + 1)}, ${this.generateExpr(
            setterExpr[setterExpr.length - idx - 1]
          )});`
      )
      .join('');

    if (setterExpr instanceof SpliceSetterExpression) {
      return `${name}:(${args.concat(['len', '...newItems']).join(',')}) => {
          const arr = ${this.pathToString(setterExpr, 1)};
          const origLength = arr.length;
          const end = len === newItems.length ? key + len : Math.max(origLength, origLength + newItems.length - len);
          for (let i = key; i < end; i++ ) {
            triggerInvalidations(arr, i);
          }
          ${this.invalidates(setterExpr) ? invalidate : ''}
          ${taint}
          ${this.pathToString(setterExpr, 1)}.splice(key, len, ...newItems);
          recalculate();
      }`;
    }
    return `${name}:(${args.concat('value').join(',')}) => {
              ${this.invalidates(setterExpr) ? invalidate : ''}
              ${taint}
              if (typeof value === 'undefined') {
                delete ${this.pathToString(setterExpr)}
              } else {
                ${this.pathToString(setterExpr)}  = value;
              }
              recalculate();
          }`;
  }

  invalidates(path) {
    const refsToPath = findReferencesToPathInAllGetters(path, this.getters);
    if (!_.isEmpty(refsToPath)) {
      return true;
    }
    return false;
  }

  pathOfExpr(expr) {
    return [new Token('topLevel'), expr[0].$rootName].concat(new Array(expr[0].$depth).fill(new Token('key')));
  }

  tracking(expr) {
    const path = this.pathOfExpr(expr);
    const tracks = [];
    const pathsThatInvalidate = expr[0].$path;
    if (pathsThatInvalidate) {
      //console.log(pathsThatInvalidate);
      pathsThatInvalidate.forEach((cond, invalidatedPath) => {
        tracks.push(
          `//invalidatedPath: ${JSON.stringify(invalidatedPath)}, ${cond}, ${
            invalidatedPath[invalidatedPath.length - 1].$type
          }`
        );
        const precond = cond ? `$cond_${cond} && ` : '';
        if (invalidatedPath[0].$type === 'topLevel') {
          if (invalidatedPath[invalidatedPath.length - 1].$type !== 'wildcard') {
            tracks.push(
              `${precond} track($invalidatedKeys, key, ${this.pathToString(invalidatedPath, 1)}
              , ${this.generateExpr(invalidatedPath[invalidatedPath.length - 1])})`
            );
          }
        } else if (invalidatedPath[0].$type === 'root') {
          Object.values(this.setters).forEach(setter => {
            if (pathMatches(invalidatedPath, setter)) {
              const setterPath = setter
                .map((t, index) => (t instanceof Token && t.$type !== 'root' && index ? invalidatedPath[index] : t))
                .slice(0, invalidatedPath.length);
              tracks.push(`// path matched ${JSON.stringify(setter)}`);
              if (setterPath[setterPath.length - 1].$type !== 'wildcard') {
                tracks.push(
                  `${precond} track($invalidatedKeys, key, ${this.pathToString(
                    setterPath.slice(0, setterPath.length - 1)
                  )}, ${this.generateExpr(setterPath[setterPath.length - 1])})`
                );
              }
            }
          });
          tracks.push('// tracking model directly');
        }
        tracks.push(`// tracking ${JSON.stringify(invalidatedPath)}`);
      });
    }
    if (tracks.filter(line => line.indexOf('//') !== 0).length > 0) {
      tracks.unshift('untrack($invalidatedKeys, key)');
    }

    return tracks.join('\n');
  }
}

module.exports = OptimizingCompiler;
