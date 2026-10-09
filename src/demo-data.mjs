/**
 * 离线演示数据集
 * ---------------------------------------------------------------
 * ⚠️ 重要声明：本文件中的菜单、价格、营养数值均为**合成示意数据**，
 *    用于在没有 MCP Token 的环境下演示算法与出图流程，**不是**任何真实门店的
 *    实时菜单、真实价格或官方营养数据。
 *
 * 所有离线演示产物都会在战报显著位置标注「演示数据」，并且 demo: true 会一路
 * 传到渲染层。真实运行时这些数据全部来自麦当劳中国 MCP，本文件不会被读取。
 */

/** 演示门店 */
export const DEMO_STORE = {
  code: 'DEMO-0001',
  name: '演示餐厅（合成数据，非真实门店）',
  address: '演示地址',
  demo: true,
};

/** 演示菜单：价格单位为「分」，与官方接口口径一致 */
export const DEMO_MENU = [
  // 主食
  { code: 'D-BIGMAC', name: '巨无霸', priceFen: 2150, category: '主食' },
  { code: 'D-SPICY', name: '麦辣鸡腿堡', priceFen: 2050, category: '主食' },
  { code: 'D-GRILL', name: '板烧鸡腿堡', priceFen: 2150, category: '主食' },
  { code: 'D-DCHEESE', name: '双层吉士汉堡', priceFen: 1850, category: '主食' },
  { code: 'D-FISH', name: '麦香鱼', priceFen: 1650, category: '主食' },
  { code: 'D-MCCHICKEN', name: '麦香鸡', priceFen: 1550, category: '主食' },
  { code: 'D-CHEESE', name: '吉士汉堡', priceFen: 1250, category: '主食' },
  { code: 'D-CRISPY', name: '原味鸡腿堡', priceFen: 1950, category: '主食' },
  { code: 'D-BACON', name: '培根蔬萃双层牛堡', priceFen: 2350, category: '主食' },
  { code: 'D-BIGMAC-SET', name: '巨无霸三件套（演示用套餐）', priceFen: 3350, category: '主食' },

  // 小食
  { code: 'D-FRIES-M', name: '薯条（中）', priceFen: 1300, category: '小食' },
  { code: 'D-NUGGET5', name: '麦乐鸡（5块）', priceFen: 1350, category: '小食' },
  { code: 'D-WINGS2', name: '麦辣鸡翅（2块）', priceFen: 1250, category: '小食' },
  { code: 'D-CORN', name: '玉米杯', priceFen: 950, category: '小食' },
  { code: 'D-APPLE', name: '苹果片', priceFen: 750, category: '小食' },
  { code: 'D-ONION', name: '洋葱圈', priceFen: 1200, category: '小食' },
  { code: 'D-SALAD', name: '蔬菜沙拉', priceFen: 1450, category: '小食' },

  // 饮料
  { code: 'D-COKE-M', name: '可口可乐（中）', priceFen: 950, category: '饮料' },
  { code: 'D-SPRITE-M', name: '雪碧（中）', priceFen: 950, category: '饮料' },
  { code: 'D-ORANGE', name: '橙汁', priceFen: 1300, category: '饮料' },
  { code: 'D-LATTE', name: '拿铁', priceFen: 1750, category: '饮料' },
  { code: 'D-AMERICANO', name: '美式咖啡', priceFen: 1500, category: '饮料' },
  { code: 'D-MILK', name: '纯牛奶', priceFen: 900, category: '饮料' },
  { code: 'D-LEMON-TEA', name: '柠檬茶', priceFen: 1200, category: '饮料' },

  // 甜品
  { code: 'D-CONE', name: '圆筒冰淇淋', priceFen: 400, category: '甜品' },
  { code: 'D-SUNDAE', name: '新地', priceFen: 900, category: '甜品' },
  { code: 'D-MCFLURRY', name: '麦旋风', priceFen: 1250, category: '甜品' },
  { code: 'D-PIE', name: '苹果派', priceFen: 800, category: '甜品' },
];

/** 演示营养库：数值为示意值，仅用于跑通算法 */
export const DEMO_NUTRITION = [
  { name: '巨无霸', energyKcal: 550, proteinG: 26, fatG: 29, carbG: 45, sodiumMg: 1050, calciumMg: 200 },
  { name: '麦辣鸡腿堡', energyKcal: 520, proteinG: 24, fatG: 26, carbG: 47, sodiumMg: 1100, calciumMg: 150 },
  { name: '板烧鸡腿堡', energyKcal: 470, proteinG: 25, fatG: 21, carbG: 45, sodiumMg: 950, calciumMg: 140 },
  { name: '双层吉士汉堡', energyKcal: 440, proteinG: 25, fatG: 23, carbG: 34, sodiumMg: 1000, calciumMg: 250 },
  { name: '麦香鱼', energyKcal: 340, proteinG: 15, fatG: 16, carbG: 34, sodiumMg: 700, calciumMg: 120 },
  { name: '麦香鸡', energyKcal: 370, proteinG: 15, fatG: 17, carbG: 38, sodiumMg: 750, calciumMg: 100 },
  { name: '吉士汉堡', energyKcal: 300, proteinG: 15, fatG: 13, carbG: 30, sodiumMg: 700, calciumMg: 200 },
  { name: '原味鸡腿堡', energyKcal: 460, proteinG: 24, fatG: 20, carbG: 44, sodiumMg: 900, calciumMg: 110 },
  { name: '培根蔬萃双层牛堡', energyKcal: 520, proteinG: 27, fatG: 27, carbG: 40, sodiumMg: 1150, calciumMg: 180 },
  { name: '薯条', energyKcal: 340, proteinG: 4, fatG: 16, carbG: 43, sodiumMg: 270, calciumMg: 20 },
  { name: '麦乐鸡', energyKcal: 230, proteinG: 13, fatG: 13, carbG: 14, sodiumMg: 480, calciumMg: 20 },
  { name: '麦辣鸡翅', energyKcal: 240, proteinG: 14, fatG: 16, carbG: 11, sodiumMg: 520, calciumMg: 15 },
  { name: '玉米杯', energyKcal: 100, proteinG: 3, fatG: 2, carbG: 20, sodiumMg: 5, calciumMg: 4 },
  { name: '苹果片', energyKcal: 35, proteinG: 0.3, fatG: 0.1, carbG: 9, sodiumMg: 1, calciumMg: 3 },
  { name: '洋葱圈', energyKcal: 240, proteinG: 3, fatG: 13, carbG: 28, sodiumMg: 400, calciumMg: 30 },
  { name: '蔬菜沙拉', energyKcal: 130, proteinG: 5, fatG: 6, carbG: 14, sodiumMg: 300, calciumMg: 60 },
  { name: '可口可乐', energyKcal: 150, proteinG: 0, fatG: 0, carbG: 38, sodiumMg: 15, calciumMg: 5 },
  { name: '雪碧', energyKcal: 140, proteinG: 0, fatG: 0, carbG: 36, sodiumMg: 30, calciumMg: 5 },
  { name: '橙汁', energyKcal: 160, proteinG: 2, fatG: 0, carbG: 37, sodiumMg: 10, calciumMg: 10 },
  { name: '拿铁', energyKcal: 130, proteinG: 8, fatG: 6, carbG: 10, sodiumMg: 90, calciumMg: 240 },
  { name: '美式咖啡', energyKcal: 15, proteinG: 1, fatG: 0, carbG: 2, sodiumMg: 10, calciumMg: 10 },
  { name: '纯牛奶', energyKcal: 130, proteinG: 7, fatG: 5, carbG: 10, sodiumMg: 90, calciumMg: 240 },
  { name: '柠檬茶', energyKcal: 120, proteinG: 0, fatG: 0, carbG: 30, sodiumMg: 20, calciumMg: 5 },
  { name: '圆筒冰淇淋', energyKcal: 150, proteinG: 4, fatG: 5, carbG: 22, sodiumMg: 70, calciumMg: 130 },
  { name: '新地', energyKcal: 280, proteinG: 6, fatG: 9, carbG: 45, sodiumMg: 110, calciumMg: 200 },
  { name: '麦旋风', energyKcal: 320, proteinG: 7, fatG: 10, carbG: 51, sodiumMg: 150, calciumMg: 220 },
  { name: '苹果派', energyKcal: 240, proteinG: 3, fatG: 11, carbG: 33, sodiumMg: 200, calciumMg: 20 },
];

/** 演示优惠券 */
export const DEMO_COUPONS = [
  { id: 'DEMO-C1', name: '满 30 元减 5 元（演示券）', discountFen: 500, thresholdFen: 3000, expireAt: null, scope: 'demo' },
  { id: 'DEMO-C2', name: '满 50 元减 12 元（演示券）', discountFen: 1200, thresholdFen: 5000, expireAt: null, scope: 'demo' },
  { id: 'DEMO-C3', name: '甜品立减 3 元（演示券）', discountFen: 300, thresholdFen: 0, expireAt: null, scope: 'demo' },
];

export function demoDataset() {
  return {
    store: DEMO_STORE,
    menu: DEMO_MENU.map((item) => ({ ...item, demo: true })),
    nutrition: DEMO_NUTRITION.map((row) => ({ ...row, demo: true })),
    coupons: DEMO_COUPONS.map((row) => ({ ...row, demo: true })),
    warnings: [
      '当前为离线演示模式：菜单、价格、营养与优惠券均为合成示意数据，不是麦当劳官方实时数据。',
      '接入 MCP Token 后（去掉 --demo）将改为调用官方接口获取真实数据。',
    ],
  };
}
