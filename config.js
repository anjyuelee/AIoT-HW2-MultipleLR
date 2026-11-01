// 可調整的設定：資料來源、預測目標、測試集比例、亂數種子
const CONFIG = {
  dataUrl: 'data/food_delivery_2026.csv',
  target: 'actual_delivery_time_min',
  testRatio: 0.2,
  seed: 42,
  // 相對 CSV 路徑會依目前網頁網址解析；sourceUrl 是頁尾顯示的資料集來源。
  presets: [
    {
      name: '外送時間預測',
      dataUrl: 'data/food_delivery_2026.csv',
      target: 'actual_delivery_time_min',
      sourceUrl: 'https://www.kaggle.com/datasets/luthfimuthathohirin/global-food-delivery-restaurant-market-2026',
      sourceLabel: 'Kaggle：Global Food Delivery Restaurant Market 2026',
      businessGoal: '在顧客下單時，估計 Online Delivery App 訂單的實際外送時間，協助營運人員理解配送時間並提供合理預估。',
      successCriteria: [
        { metric: 'rmse', label: '測試集 RMSE ≤ 5 分鐘', max: 5, unit: '分鐘' },
        { metric: 'piCoverage', label: '95% 預測區間涵蓋率介於 93–97%', min: 93, max: 97, unit: '%' },
        { metric: 'r2Drop', label: '測試 R² 相較全特徵模型下降 ≤ 0.01', max: 0.01, unit: '' },
      ],
    },
    {
      name: '平均壽命預測',
      dataUrl: 'data/life_expectancy.csv',
      target: 'Life expectancy',
      groupColumn: 'Country',
      sourceUrl: 'https://www.kaggle.com/datasets/kumarajarshi/life-expectancy-who',
      sourceLabel: 'Kaggle：Life Expectancy (WHO)',
      businessGoal: '使用國家年度健康、教育與經濟指標估計平均預期壽命，作為跨國公共衛生趨勢分析的原型。',
      successCriteria: [
        { metric: 'mae', label: '測試集 MAE ≤ 3 年', max: 3, unit: '年' },
        { metric: 'piCoverage', label: '95% 預測區間涵蓋率介於 90–98%', min: 90, max: 98, unit: '%' },
        { metric: 'maeIncrease', label: '測試 MAE 相較全特徵模型增加 ≤ 0.5 年', max: 0.5, unit: '年' },
      ],
    },
  ],
};
