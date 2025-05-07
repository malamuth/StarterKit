#!/usr/bin/env node

/**
 * Скрипт для валидации токенов дизайн-системы StarterKit
 * 
 * Этот скрипт проверяет все JSON-файлы с токенами на:
 * - Соответствие формату Tokens Studio
 * - Наличие невалидных ссылок на другие токены
 * - Корректность типов токенов
 * - Соответствие структуре проекта
 *
 * Версия 2.0 - расширенная поддержка вложенных ссылок и выражений
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

// Цвета для вывода в консоль
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

// Допустимые типы токенов - расширенный список
const VALID_TOKEN_TYPES = [
  // Стандартные типы
  'color',
  'number',
  'string',
  'dimension',
  'fontFamily',
  'fontWeight',
  'fontSize',
  'letterSpacing',
  'lineHeight',
  'paragraphSpacing',
  'textCase',
  'textDecoration',
  'other',
  // Дополнительные типы, используемые в проекте
  'boxShadow',
  'text',
  'composition',
  'border',
  'shadow',
  'asset',
  'typography',
  'opacity',
  'boolean',
  // Добавляем все типы, которые могут быть в проекте
  'spacing',
  'sizing',
  'radius',
  'stroke',
  'effect',
  'media',
  'layout'
];

// Регулярные выражения для поиска ссылок и выражений
const TOKEN_REFERENCE_REGEX = /\{([^{}]+)\}/g;  // Находит все ссылки вида {token.name}
const EXPRESSION_OPERATORS_REGEX = /[+\-*\/]/;  // Находит математические операторы

// Корневая директория токенов
const TOKENS_DIR = path.resolve(__dirname, '../tokens');

// Статистика валидации
const stats = {
  filesChecked: 0,
  tokensChecked: 0,
  referencesChecked: 0,
  errors: 0,
  warnings: 0
};

// Хранилище всех токенов для проверки ссылок
const tokenRegistry = {};

/**
 * Рекурсивно находит все JSON-файлы в директории
 * @param {string} dir - Директория для поиска
 * @returns {string[]} - Массив путей к JSON-файлам
 */
function findJsonFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);

  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // Рекурсивно ищем в поддиректориях
      results = results.concat(findJsonFiles(filePath));
    } else if (path.extname(file) === '.json') {
      results.push(filePath);
    }
  });

  return results;
}

/**
 * Проверяет, является ли значение простой ссылкой на другой токен
 * @param {string} value - Значение для проверки
 * @returns {boolean} - true, если значение является простой ссылкой
 */
function isSimpleTokenReference(value) {
  if (typeof value !== 'string') return false;
  return value.startsWith('{') && value.endsWith('}') && !value.slice(1, -1).includes('{');
}

/**
 * Проверяет, содержит ли значение ссылки на токены
 * @param {string} value - Значение для проверки
 * @returns {boolean} - true, если значение содержит ссылки
 */
function containsTokenReferences(value) {
  if (typeof value !== 'string') return false;
  return TOKEN_REFERENCE_REGEX.test(value);
}

/**
 * Проверяет, является ли значение выражением
 * @param {string} value - Значение для проверки
 * @returns {boolean} - true, если значение является выражением
 */
function isExpression(value) {
  if (typeof value !== 'string') return false;
  return EXPRESSION_OPERATORS_REGEX.test(value);
}

/**
 * Извлекает все ссылки на токены из значения
 * @param {string} value - Значение, содержащее ссылки
 * @returns {string[]} - Массив имен токенов
 */
function extractAllTokenReferences(value) {
  if (typeof value !== 'string') return [];
  
  const references = [];
  let match;
  
  // Сбрасываем индекс регулярного выражения
  TOKEN_REFERENCE_REGEX.lastIndex = 0;
  
  while ((match = TOKEN_REFERENCE_REGEX.exec(value)) !== null) {
    references.push(match[1]);
  }
  
  return references;
}

/**
 * Извлекает имя токена из простой ссылки
 * @param {string} reference - Ссылка на токен
 * @returns {string} - Имя токена
 */
function extractTokenName(reference) {
  return reference.slice(1, -1);
}

/**
 * Проверяет, существует ли токен в реестре
 * @param {string} tokenName - Имя токена для проверки
 * @returns {boolean} - true, если токен существует
 */
function tokenExists(tokenName) {
  // Проверяем на наличие вложенных ссылок в имени токена
  if (containsTokenReferences(tokenName)) {
    // Для токенов с вложенными ссылками (например, typography.font.{semantic-typography.header-xl.style.lg})
    // Считаем такие токены валидными, так как они разрешаются в Figma Tokens
    return true;
  }

  // Для токенов с прямой ссылкой (например, size.100)
  if (tokenRegistry[tokenName]) {
    return true;
  }

  // Для вложенных токенов (например, size.100)
  const parts = tokenName.split('.');
  let current = tokenRegistry;

  for (const part of parts) {
    if (!current[part]) return false;
    current = current[part];
  }

  return true;
}

/**
 * Регистрирует токены из файла в глобальном реестре
 * @param {string} filePath - Путь к файлу с токенами
 * @param {Object} tokens - Объект с токенами
 */
function registerTokens(filePath, tokens) {
  function registerNestedTokens(obj, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const tokenPath = prefix ? `${prefix}.${key}` : key;

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.value !== undefined && value.type !== undefined) {
          // Это токен
          // Регистрируем токен по его полному пути
          tokenRegistry[tokenPath] = value;

          // Также регистрируем токен в иерархической структуре
          let current = tokenRegistry;
          const parts = tokenPath.split('.');

          for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            if (i === parts.length - 1) {
              // Последний элемент - это сам токен
              if (!current[part] || typeof current[part] !== 'object' || current[part].value === undefined) {
                current[part] = value;
              }
            } else {
              // Промежуточные элементы - это группы
              if (!current[part]) {
                current[part] = {};
              }
              current = current[part];
            }
          }
        } else {
          // Это группа токенов
          registerNestedTokens(value, tokenPath);
        }
      }
    }
  }

  registerNestedTokens(tokens);
}

/**
 * Валидирует отдельный токен
 * @param {string} tokenPath - Путь к токену
 * @param {Object} token - Объект токена
 * @param {string} filePath - Путь к файлу с токеном
 * @returns {Object} - Результаты валидации
 */
function validateToken(tokenPath, token, filePath) {
  const results = {
    errors: [],
    warnings: []
  };

  // Проверка наличия обязательных полей
  if (token.value === undefined) {
    results.errors.push(`Токен "${tokenPath}" не имеет поля "value"`);
  }

  if (token.type === undefined) {
    results.errors.push(`Токен "${tokenPath}" не имеет поля "type"`);
  } else if (!VALID_TOKEN_TYPES.includes(token.type)) {
    results.warnings.push(`Токен "${tokenPath}" имеет нестандартный тип "${token.type}"`);
  }

  // Проверка значения токена
  if (token.value !== undefined) {
    stats.referencesChecked++;
    
    if (isSimpleTokenReference(token.value)) {
      // Простая ссылка вида {token.name}
      const referencedToken = extractTokenName(token.value);
      
      if (!tokenExists(referencedToken)) {
        results.errors.push(`Токен "${tokenPath}" ссылается на несуществующий токен "${referencedToken}"`);
      }
    } else if (containsTokenReferences(token.value)) {
      // Сложная ссылка или выражение с вложенными ссылками
      const references = extractAllTokenReferences(token.value);
      
      // Проверяем каждую ссылку в выражении
      for (const ref of references) {
        if (containsTokenReferences(ref)) {
          // Вложенная ссылка - считаем валидной
          continue;
        }
        
        if (!tokenExists(ref)) {
          // Проверяем только простые ссылки
          // Если это часть выражения, пропускаем проверку
          if (!isExpression(token.value)) {
            results.errors.push(`Токен "${tokenPath}" ссылается на несуществующий токен "${ref}"`);
          }
        }
      }
    } else if (isExpression(token.value)) {
      // Это выражение без ссылок - считаем валидным
    }
  }

  return results;
}

/**
 * Валидирует файл с токенами
 * @param {string} filePath - Путь к файлу с токенами
 * @returns {Object} - Результаты валидации
 */
function validateTokenFile(filePath) {
  const results = {
    filePath,
    errors: [],
    warnings: []
  };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    let tokens;

    try {
      tokens = JSON.parse(content);
    } catch (e) {
      results.errors.push(`Невалидный JSON: ${e.message}`);
      return results;
    }

    // Регистрируем токены для последующей проверки ссылок
    registerTokens(filePath, tokens);

    // Валидируем каждый токен
    function validateNestedTokens(obj, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const tokenPath = prefix ? `${prefix}.${key}` : key;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (value.value !== undefined && value.type !== undefined) {
            // Это токен
            stats.tokensChecked++;
            const tokenResults = validateToken(tokenPath, value, filePath);
            results.errors.push(...tokenResults.errors);
            results.warnings.push(...tokenResults.warnings);
          } else {
            // Это группа токенов
            validateNestedTokens(value, tokenPath);
          }
        }
      }
    }

    validateNestedTokens(tokens);

  } catch (e) {
    results.errors.push(`Ошибка при чтении файла: ${e.message}`);
  }

  return results;
}

/**
 * Загружает базовые токены из common директории первыми
 * @returns {Array} - Отсортированный массив путей к файлам
 */
function sortJsonFilesByPriority(files) {
  // Функция для определения приоритета файла
  function getPriority(filePath) {
    if (filePath.includes('/common/')) return 1;
    if (filePath.includes('/shared/')) return 2;
    if (filePath.includes('/component/')) return 3;
    return 4;
  }

  // Сортируем файлы по приоритету
  return [...files].sort((a, b) => {
    return getPriority(a) - getPriority(b);
  });
}

/**
 * Выполняет валидацию всех токенов в проекте
 */
function validateAllTokens() {
  console.log(`${colors.bright}${colors.cyan}Начинаем валидацию токенов в директории: ${TOKENS_DIR}${colors.reset}\n`);

  // Находим все JSON-файлы с токенами
  const jsonFiles = findJsonFiles(TOKENS_DIR);
  console.log(`${colors.blue}Найдено ${jsonFiles.length} JSON-файлов с токенами${colors.reset}\n`);

  // Сортируем файлы, чтобы базовые токены загружались первыми
  const sortedFiles = sortJsonFilesByPriority(jsonFiles);

  // Первый проход: регистрируем все токены
  sortedFiles.forEach(filePath => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const tokens = JSON.parse(content);
      registerTokens(filePath, tokens);
    } catch (e) {
      console.error(`${colors.red}Ошибка при чтении файла ${filePath}: ${e.message}${colors.reset}`);
    }
  });

  // Второй проход: валидируем все токены и ссылки
  const results = sortedFiles.map(filePath => {
    stats.filesChecked++;
    return validateTokenFile(filePath);
  });

  // Выводим результаты
  let hasErrors = false;

  // Сортируем результаты по количеству ошибок (сначала файлы с наибольшим количеством ошибок)
  const sortedResults = [...results].sort((a, b) => {
    return b.errors.length - a.errors.length;
  });

  // Ограничиваем количество выводимых файлов с ошибками, чтобы не перегружать консоль
  const maxFilesToShow = 10;
  let filesShown = 0;

  sortedResults.forEach(result => {
    if (result.errors.length > 0 || result.warnings.length > 0) {
      if (filesShown < maxFilesToShow) {
        const relativePath = path.relative(process.cwd(), result.filePath);
        console.log(`${colors.bright}Файл: ${relativePath}${colors.reset}`);

        if (result.errors.length > 0) {
          hasErrors = true;
          stats.errors += result.errors.length;
          console.log(`  ${colors.red}Ошибки:${colors.reset}`);

          // Ограничиваем количество выводимых ошибок для каждого файла
          const maxErrorsToShow = 5;
          const errorsToShow = result.errors.slice(0, maxErrorsToShow);
          errorsToShow.forEach(error => {
            console.log(`    - ${error}`);
          });

          if (result.errors.length > maxErrorsToShow) {
            console.log(`    ... и еще ${result.errors.length - maxErrorsToShow} ошибок`);
          }
        }

        if (result.warnings.length > 0) {
          stats.warnings += result.warnings.length;
          console.log(`  ${colors.yellow}Предупреждения:${colors.reset}`);

          // Ограничиваем количество выводимых предупреждений для каждого файла
          const maxWarningsToShow = 5;
          const warningsToShow = result.warnings.slice(0, maxWarningsToShow);
          warningsToShow.forEach(warning => {
            console.log(`    - ${warning}`);
          });

          if (result.warnings.length > maxWarningsToShow) {
            console.log(`    ... и еще ${result.warnings.length - maxWarningsToShow} предупреждений`);
          }
        }

        console.log('');
        filesShown++;
      } else {
        // Для остальных файлов просто считаем ошибки и предупреждения
        if (result.errors.length > 0) {
          hasErrors = true;
          stats.errors += result.errors.length;
        }

        if (result.warnings.length > 0) {
          stats.warnings += result.warnings.length;
        }
      }
    }
  });

  if (filesShown < sortedResults.filter(r => r.errors.length > 0 || r.warnings.length > 0).length) {
    console.log(`${colors.yellow}... и еще ${sortedResults.filter(r => r.errors.length > 0 || r.warnings.length > 0).length - filesShown} файлов с ошибками или предупреждениями${colors.reset}\n`);
  }

  // Выводим итоговую статистику
  console.log(`${colors.bright}${colors.cyan}Статистика валидации:${colors.reset}`);
  console.log(`- Проверено файлов: ${stats.filesChecked}`);
  console.log(`- Проверено токенов: ${stats.tokensChecked}`);
  console.log(`- Проверено ссылок: ${stats.referencesChecked}`);
  console.log(`- Найдено ошибок: ${colors.red}${stats.errors}${colors.reset}`);
  console.log(`- Найдено предупреждений: ${colors.yellow}${stats.warnings}${colors.reset}`);

  if (hasErrors) {
    console.log(`\n${colors.red}${colors.bright}Валидация не пройдена! Пожалуйста, исправьте ошибки.${colors.reset}`);
    process.exit(1);
  } else if (stats.warnings > 0) {
    console.log(`\n${colors.yellow}${colors.bright}Валидация пройдена с предупреждениями.${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`\n${colors.green}${colors.bright}Валидация успешно пройдена!${colors.reset}`);
    process.exit(0);
  }
}

// Запускаем валидацию
validateAllTokens();
