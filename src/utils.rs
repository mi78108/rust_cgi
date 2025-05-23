use std::collections::HashMap;

pub trait Json<T> {
    fn stringify(&self, func:fn(&T)->(String,String)) -> String;
}

struct extHashMap<K,V> {
    hashmap :HashMap<K,V>
}

impl<K,V> extHashMap<K,V> {
    fn new()->Self {
        return extHashMap{
            hashmap: HashMap::new(),
        };
    }
}

impl<K,V> Json<(K,V)> for HashMap<K,V> where K:Clone, V:Clone{
    fn stringify(&self, func:fn(&(K,V))->(String,String)) -> String{
        format!("{{{}}}", self.iter().map(|(k,v)|{
            let (k,v) = func(&(k.clone(),v.clone()));
            format!("\"{}\":\"{}\"",k,v)
        }).collect::<Vec<String>>().join(","))
    }
}

impl<T> Json<T> for Vec<T> {
    fn stringify(&self, func:fn(&T)->(String,String)) -> String {
        format!("[{}]",self.iter().map(|v|{
            func(v)
        }).map(|v| v.1).collect::<Vec<String>>().join(","))
    }
}

fn map_to_json<K,V>(map:&HashMap<K,V>,func:fn(&K,&V)->(String,String))->String{
    let mut rst = String::from("{");
    rst.push_str(map.iter().map(|(k,v)|{
        let (k,v) = func(k,v);
        format!("\"{}\":\"{}\"",k,v)
    }).collect::<Vec<String>>().join(",").as_str());
    rst.push_str("}");
    return rst;
}

#[test]
fn test(){
    
}
