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
    },
    {
      name: '平均壽命預測',
      dataUrl: 'data/life_expectancy.csv',
      target: 'Life expectancy',
      groupColumn: 'Country',
      sourceUrl: 'https://www.kaggle.com/datasets/kumarajarshi/life-expectancy-who',
      sourceLabel: 'Kaggle：Life Expectancy (WHO)',
    },
  ],
};
