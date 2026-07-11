import path from "node:path";

function isCnCall(node) {
  return node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "cn";
}

function hasMultipleClasses(value) {
  return /\s/.test(value.trim());
}

function getCnImportPath(filename) {
  const normalizedFilename = path.resolve(filename);
  const srcSegment = `${path.sep}src${path.sep}`;
  const srcIndex = normalizedFilename.lastIndexOf(srcSegment);

  if (srcIndex === -1) {
    return null;
  }

  const packageRoot = normalizedFilename.slice(0, srcIndex);
  const targetPath = path.join(packageRoot, "src", "lib", "cn");
  let relativePath = path.relative(path.dirname(normalizedFilename), targetPath);

  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }

  return relativePath.split(path.sep).join("/");
}

function programHasCnImport(program, importPath) {
  return program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === importPath &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "cn",
      ),
  );
}

function buildCnImportFixes(context, fixer) {
  const filename = context.filename ?? context.getFilename();
  const importPath = getCnImportPath(filename);

  if (!importPath) {
    return [];
  }

  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const program = sourceCode.ast;

  if (programHasCnImport(program, importPath)) {
    return [];
  }

  const importDeclarations = program.body.filter((statement) => statement.type === "ImportDeclaration");
  const importStatement = `import { cn } from "${importPath}";\n`;

  if (importDeclarations.length === 0) {
    return [fixer.insertTextBefore(program.body[0] ?? program, importStatement)];
  }

  return [fixer.insertTextAfter(importDeclarations.at(-1), `\n${importStatement}`)];
}

function traverse(node, visitorKeys, callback) {
  callback(node);

  const keys = visitorKeys[node.type] ?? [];
  for (const key of keys) {
    const value = node[key];

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type) {
          traverse(child, visitorKeys, callback);
        }
      }
      continue;
    }

    if (value?.type) {
      traverse(value, visitorKeys, callback);
    }
  }
}

function isInsideObjectPropertyValue(node, cnCall) {
  let current = node;

  while (current && current !== cnCall) {
    const parent = current.parent;

    if (!parent) {
      return false;
    }

    if (
      parent.type === "Property" &&
      parent.value === current &&
      parent.parent?.type === "ObjectExpression"
    ) {
      return true;
    }

    current = parent;
  }

  return false;
}

const requireCnForClassname = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require cn(...) for multi-class or dynamic className values.",
    },
    fixable: "code",
    schema: [],
    messages: {
      wrapWithCn: "Wrap multi-class className values with cn(...).",
      dynamicNeedsCn: "Use cn(...) for dynamic className expressions.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "className" || !node.value) {
          return;
        }

        if (node.value.type === "Literal" && typeof node.value.value === "string") {
          if (!hasMultipleClasses(node.value.value)) {
            return;
          }

          context.report({
            node: node.value,
            messageId: "wrapWithCn",
            fix(fixer) {
              return [
                fixer.replaceText(node.value, `{cn(${sourceCode.getText(node.value)})}`),
                ...buildCnImportFixes(context, fixer),
              ];
            },
          });
          return;
        }

        if (node.value.type !== "JSXExpressionContainer") {
          return;
        }

        const expression = node.value.expression;

        if (isCnCall(expression)) {
          return;
        }

        if (
          expression.type === "Literal" &&
          typeof expression.value === "string" &&
          hasMultipleClasses(expression.value)
        ) {
          context.report({
            node: expression,
            messageId: "wrapWithCn",
            fix(fixer) {
              return [
                fixer.replaceText(node.value, `{cn(${sourceCode.getText(expression)})}`),
                ...buildCnImportFixes(context, fixer),
              ];
            },
          });
          return;
        }

        context.report({
          node: expression,
          messageId: "dynamicNeedsCn",
        });
      },
    };
  },
};

const preferObjectSyntaxInCn = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require object syntax for conditional classes inside cn(...).",
    },
    schema: [],
    messages: {
      noTernary: "Do not use ternary expressions inside cn(...). Use object syntax instead.",
      noLogical: "Use object syntax for conditional classes inside cn(...).",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const visitorKeys = sourceCode.visitorKeys;

    return {
      CallExpression(node) {
        if (!isCnCall(node)) {
          return;
        }

        for (const argument of node.arguments) {
          if (argument.type === "ConditionalExpression") {
            context.report({
              node: argument,
              messageId: "noTernary",
            });
            continue;
          }

          if (argument.type === "LogicalExpression") {
            context.report({
              node: argument,
              messageId: "noLogical",
            });
            continue;
          }

          traverse(argument, visitorKeys, (child) => {
            if (child === argument) {
              return;
            }

            if (child.type === "ConditionalExpression") {
              context.report({
                node: child,
                messageId: "noTernary",
              });
              return;
            }

            if (child.type === "LogicalExpression" && !isInsideObjectPropertyValue(child, node)) {
              context.report({
                node: child,
                messageId: "noLogical",
              });
            }
          });
        }
      },
    };
  },
};

export default {
  rules: {
    "prefer-object-syntax-in-cn": preferObjectSyntaxInCn,
    "require-cn-for-classname": requireCnForClassname,
  },
};
