const fs = require('fs');
const path = require('path');
const glob = require('glob');
const chalk = require('chalk');

// Кэш для загруженных токенов
const tokenCache = new Map();

// Функция для загрузки JSON файла
function loadJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(chalk.red(`Error loading ${filePath}:`), error.message);
    process.exit(1);
  }
}

// Функция для получения значения токена по пути
function getTokenValue(tokens, tokenPath) {
  // Проверяем на вложенные ссылки
  const nestedTokenRegex = /\{([^{}]+)\}/g;
  let resolvedPath = tokenPath;
  let match;
  let maxIterations = 10; // Защита от бесконечного цикла
  let iterations = 0;

  // Разрешаем все вложенные ссылки
  while ((match = nestedTokenRegex.exec(resolvedPath)) !== null && iterations < maxIterations) {
    const nestedPath = match[1];
    
    // Если в nestedPath есть еще вложенные ссылки, сначала разрешаем их
    if (nestedPath.includes('{')) {
      const nestedValue = getTokenValue(tokens, nestedPath);
      if (nestedValue === undefined) {
        return undefined;
      }
      resolvedPath = resolvedPath.replace(match[0], nestedValue);
    } else {
      const parts = nestedPath.split('.');
      let current = tokens;

      for (const part of parts) {
        if (!current || typeof current !== 'object') {
          return undefined;
        }
        current = current[part];
      }

      if (current === undefined) {
        return undefined;
      }

      if (typeof current === 'object' && current.value) {
        resolvedPath = resolvedPath.replace(match[0], current.value);
      } else {
        resolvedPath = resolvedPath.replace(match[0], current);
      }
    }

    // Сбрасываем lastIndex для следующего поиска
    nestedTokenRegex.lastIndex = 0;
    iterations++;
  }

  // Если после разрешения всех вложенных ссылок остались фигурные скобки,
  // значит что-то пошло не так
  if (resolvedPath.includes('{') || resolvedPath.includes('}')) {
    return undefined;
  }

  // Если в пути остались только точки, разрешаем их
  const parts = resolvedPath.split('.');
  let current = tokens;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

// Функция для проверки ссылок на токены
function validateTokenReferences(tokens, filePath, allTokens) {
  const errors = [];
  const warnings = [];

  function validateValue(value, path) {
    if (typeof value === 'object' && value !== null) {
      if (value.value && typeof value.value === 'string') {
        // Проверяем на математические операции
        if (value.value.includes(' + ')) {
          const parts = value.value.split(' + ');
          let isValid = true;

          for (const part of parts) {
            if (part.startsWith('{') && part.endsWith('}')) {
              const tokenPath = part.slice(1, -1);
              const tokenValue = getTokenValue(allTokens, tokenPath);
              
              if (tokenValue === undefined) {
                isValid = false;
                break;
              }
            } else {
              // Разрешаем числовые значения в математических операциях
              if (!/^\d+(\.\d+)?$/.test(part.trim())) {
                isValid = false;
                break;
              }
            }
          }

          if (!isValid) {
            errors.push({
              path: path,
              reference: value.value,
              message: `Invalid token reference: ${value.value}`
            });
          }
        }
        // Проверяем ссылки на токены
        else if (value.value.startsWith('{')) {
          // Находим все ссылки на токены в строке
          const tokenRefs = value.value.match(/\{([^{}]+)\}/g);
          if (!tokenRefs) {
            errors.push({
              path: path,
              reference: value.value,
              message: `Invalid token reference format: ${value.value}`
            });
            return;
          }

          let isValid = true;
          for (const ref of tokenRefs) {
            const tokenPath = ref.slice(1, -1);
            const tokenValue = getTokenValue(allTokens, tokenPath);

            if (tokenValue === undefined) {
              isValid = false;
              break;
            }
          }

          if (!isValid) {
            errors.push({
              path: path,
              reference: value.value,
              message: `Invalid token reference: ${value.value}`
            });
          }
        }
      }
      
      // Рекурсивно проверяем все свойства объекта
      Object.entries(value).forEach(([key, val]) => {
        validateValue(val, path ? `${path}.${key}` : key);
      });
    }
  }

  validateValue(tokens, '');
  return { errors, warnings };
}

// Основная функция валидации
async function validateTokens() {
  let hasErrors = false;
  let hasWarnings = false;

  // Загружаем все токены
  const tokenFiles = glob.sync('tokens/**/*.json', { cwd: process.cwd() });
  const allTokens = {};

  // Рекурсивная функция для глубокого объединения объектов
  function deepMerge(target, source) {
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          target[key] = target[key] || {};
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }
    return target;
  }

  // Сначала загружаем все файлы
  console.log(chalk.blue('\nLoading token files...'));
  tokenFiles.forEach(file => {
    try {
      const tokens = loadJsonFile(file);
      deepMerge(allTokens, tokens);
      tokenCache.set(file, tokens);
      console.log(chalk.green(`✓ Loaded ${file}`));
    } catch (error) {
      console.error(chalk.red(`✗ Failed to load ${file}:`), error.message);
      hasErrors = true;
    }
  });

  // Затем проверяем ссылки
  console.log(chalk.blue('\nValidating token references...'));
  tokenFiles.forEach(file => {
    const tokens = tokenCache.get(file);
    if (tokens) {
      const { errors, warnings } = validateTokenReferences(tokens, file, allTokens);
      
      if (errors.length > 0 || warnings.length > 0) {
        console.log(chalk.yellow(`\nFile: ${file}`));
        
        if (errors.length > 0) {
          console.log(chalk.red('  Errors:'));
          errors.forEach(error => {
            console.log(chalk.red(`    - [${error.path}] ${error.message}`));
          });
          hasErrors = true;
        }
        
        if (warnings.length > 0) {
          console.log(chalk.yellow('  Warnings:'));
          warnings.forEach(warning => {
            console.log(chalk.yellow(`    - [${warning.path}] ${warning.message}`));
          });
          hasWarnings = true;
        }
      } else {
        console.log(chalk.green(`✓ ${file} is valid`));
      }
    }
  });

  console.log('\n' + '='.repeat(80));
  if (hasErrors) {
    console.error(chalk.red('\n✗ Validation failed! Please fix the errors above.'));
    process.exit(1);
  } else if (hasWarnings) {
    console.log(chalk.yellow('\n⚠ Validation passed with warnings.'));
  } else {
    console.log(chalk.green('\n✓ All tokens are valid!'));
  }
}

validateTokens().catch(error => {
  console.error(chalk.red('Unexpected error:'), error);
  process.exit(1);
});
